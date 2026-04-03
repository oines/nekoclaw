import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	AuthStorage,
	ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import { MODEL_ENV_MAP } from "../../model/provider-key.js";
import { JsonNekoclawStore } from "../../store/json-store.js";
import { ensureParentDir, readJsonFile, readTextFile, removeFileIfExists, withFileLock, writeJsonFile, writeTextFile } from "../../store/fs.js";
import { StorePaths } from "../../store/paths.js";
import type { AgentSpec, InboundMessageEvent, PreparedPersonaContext, SessionRecord, WorkerPayload } from "../../types.js";
import { DREAM_INTERVAL_MS, FORMATION_MAX_RETRIES, INDEX_TOKEN_BUDGET } from "./constants.js";
import { buildDreamPrompt, buildDreamSkipKey } from "./dream.js";
import { buildFormationBacklogPrompt, buildFormationTurnPrompt } from "./formation.js";
import { buildDreamCorpusSnapshot } from "./manifest.js";
import { createMaintenanceClone, destroyMaintenanceClone, executeMaintenanceSession, syncMaintenanceClone } from "./maintenance-agent.js";
import { buildObservationSignature, buildSceneMemoryPath, buildSceneRef, formatObservationLine, shouldRunFormationForObservations, takeTailLinesWithinBudget, trimToTokenBudget } from "./observations.js";
import { PersonaPaths } from "./paths.js";
import type { DreamState, FormationRetryState, PersonaMemoryRuntimeState } from "./types.js";

export class PersonaMemoryService {
	private readonly storePaths = new StorePaths();

	private readonly state: PersonaMemoryRuntimeState = {
		maintenanceLocks: new Map<string, Promise<void>>(),
		backlogSweepQueued: new Set<string>(),
		dreamQueued: new Set<string>(),
		dreamSkipAuditCache: new Map<string, string>(),
	};

	constructor(private readonly store: JsonNekoclawStore) {}

	recordInbound(agentId: string, session: SessionRecord | undefined, event: InboundMessageEvent): void {
		const agent = this.store.getAgentByRef(agentId);
		const paths = this.ensurePersonaLayout(agent.slug);
		const sceneRef = buildSceneRef(session, event);
		const path = paths.observationPath(sceneRef);
		const line = `${formatObservationLine(event)}\n`;
		withFileLock(path, () => {
			ensureParentDir(path);
			appendFileSync(path, line, "utf-8");
		});
	}

	async buildPreparedContext(
		agent: AgentSpec,
		session: SessionRecord,
		event: InboundMessageEvent,
	): Promise<PreparedPersonaContext> {
		const paths = this.ensurePersonaLayout(agent.slug);
		const sceneRef = buildSceneRef(session, event);
		const indexMarkdown = trimToTokenBudget(readTextFile(paths.indexPath, ""), INDEX_TOKEN_BUDGET);
		const sceneObservations = this.readSceneObservations(paths, sceneRef);
		return {
			indexMarkdown,
			sceneObservations,
		};
	}

	scheduleFormation(input: {
		agent: AgentSpec;
		session: SessionRecord;
		event: InboundMessageEvent;
		turnTranscript: string;
		personaContext: PreparedPersonaContext;
		effectiveModel?: WorkerPayload["effectiveModel"];
	}): void {
		this.enqueueMaintenance(input.agent.agentId, async () => {
			await this.runFormationForTurn(input);
		});
	}

	queueBacklogSweep(agent: AgentSpec): void {
		if (this.state.backlogSweepQueued.has(agent.agentId)) {
			return;
		}
		this.state.backlogSweepQueued.add(agent.agentId);
		this.enqueueMaintenance(agent.agentId, async () => {
			try {
				await this.runBacklogSweep(agent);
			} finally {
				this.state.backlogSweepQueued.delete(agent.agentId);
			}
		});
	}

	queueDream(agent: AgentSpec, options?: { force?: boolean; skipReason?: string }): void {
		if (options?.skipReason) {
			this.auditDreamSkip(agent, options.skipReason, {});
			return;
		}
		if (this.state.dreamQueued.has(agent.agentId)) {
			this.auditDreamSkip(agent, "already_queued", {});
			return;
		}
		const paths = this.ensurePersonaLayout(agent.slug);
		const state = this.readDreamState(paths);
		if (!options?.force && state.lastCompletedAt) {
			const lastCompletedAt = Date.parse(state.lastCompletedAt);
			if (!Number.isNaN(lastCompletedAt) && Date.now() - lastCompletedAt < DREAM_INTERVAL_MS) {
				this.auditDreamSkip(agent, "not_due", { lastCompletedAt: state.lastCompletedAt });
				return;
			}
		}
		const snapshot = buildDreamCorpusSnapshot(paths);
		if (snapshot.indexSizeBytes === 0 && snapshot.manifest.length === 0 && snapshot.observations.length === 0) {
			this.auditDreamSkip(agent, "no_memory_files", {});
			return;
		}
		if (!options?.force && state.lastCorpusSignature && state.lastCorpusSignature === snapshot.corpusSignature) {
			this.auditDreamSkip(agent, "no_corpus_change", { corpusSignature: snapshot.corpusSignature });
			return;
		}
		this.state.dreamQueued.add(agent.agentId);
		this.state.dreamSkipAuditCache.delete(agent.agentId);
		this.store.audit(agent.agentId, "persona.dream_queued", {
			corpusSignature: snapshot.corpusSignature,
			peopleFiles: snapshot.manifest.filter((entry) => entry.kind === "people").length,
			sceneFiles: snapshot.manifest.filter((entry) => entry.kind === "scene").length,
			observationFiles: snapshot.observations.length,
		});
		this.enqueueMaintenance(agent.agentId, async () => {
			try {
				await this.runDream(agent);
			} finally {
				this.state.dreamQueued.delete(agent.agentId);
			}
		});
	}

	noteDreamSkip(agent: AgentSpec, reason: "agent_busy"): void {
		this.auditDreamSkip(agent, reason, {});
	}

	whenIdle(agentId: string): Promise<void> {
		return (this.state.maintenanceLocks.get(agentId) ?? Promise.resolve()).catch(() => undefined);
	}

	private getPersonaPaths(slug: string): PersonaPaths {
		return new PersonaPaths(this.storePaths, slug);
	}

	private ensurePersonaLayout(slug: string): PersonaPaths {
		const paths = this.getPersonaPaths(slug);
		for (const dir of [paths.personaDir, paths.peopleDir, paths.scenesDir, paths.observationsDir, paths.controlDir, paths.formationRetryDir]) {
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
		}
		if (!existsSync(paths.indexPath)) {
			writeTextFile(paths.indexPath, "");
		}
		return paths;
	}

	private readSceneObservations(paths: PersonaPaths, sceneRef: string): string {
		return takeTailLinesWithinBudget(readTextFile(paths.observationPath(sceneRef), ""));
	}

	private scanPersonaMemoryManifest(slug: string) {
		return buildDreamCorpusSnapshot(this.ensurePersonaLayout(slug)).manifest;
	}

	private buildDreamCorpusSnapshot(slug: string) {
		return buildDreamCorpusSnapshot(this.ensurePersonaLayout(slug));
	}

	private async executeMaintenanceSession(
		agent: AgentSpec,
		effectiveModel: WorkerPayload["effectiveModel"] | undefined,
		input: Omit<Parameters<typeof executeMaintenanceSession>[0], "agent" | "effectiveModel">,
	) {
		return await executeMaintenanceSession({
			...input,
			agent,
			effectiveModel,
		});
	}

	private readFormationRetryState(paths: PersonaPaths, sceneRef: string): FormationRetryState | undefined {
		const path = paths.formationRetryStatePath(sceneRef);
		if (!existsSync(path)) {
			return undefined;
		}
		const state = readJsonFile<FormationRetryState | undefined>(path, undefined);
		if (!state?.signature || typeof state.attempts !== "number") {
			return undefined;
		}
		return state;
	}

	private clearFormationRetryState(paths: PersonaPaths, sceneRef: string): void {
		removeFileIfExists(paths.formationRetryStatePath(sceneRef));
	}

	private readDreamState(paths: PersonaPaths): DreamState {
		return readJsonFile<DreamState>(paths.dreamStatePath, {});
	}

	private writeDreamState(paths: PersonaPaths, state: DreamState): void {
		writeJsonFile(paths.dreamStatePath, state);
	}

	private auditDreamSkip(agent: AgentSpec, reason: string, details: Record<string, unknown>): void {
		const cacheKey = buildDreamSkipKey(reason, details);
		if (this.state.dreamSkipAuditCache.get(agent.agentId) === cacheKey) {
			return;
		}
		this.state.dreamSkipAuditCache.set(agent.agentId, cacheKey);
		this.store.audit(agent.agentId, "persona.dream_skipped", {
			reason,
			...details,
		});
	}

	private clearDreamSkipAudit(agentId: string): void {
		this.state.dreamSkipAuditCache.delete(agentId);
	}

	private async runFormationForTurn(input: {
		agent: AgentSpec;
		session: SessionRecord;
		event: InboundMessageEvent;
		turnTranscript: string;
		personaContext: PreparedPersonaContext;
		effectiveModel?: WorkerPayload["effectiveModel"];
	}): Promise<void> {
		const paths = this.ensurePersonaLayout(input.agent.slug);
		if (!this.resolveModel(input.agent, input.effectiveModel)) {
			return;
		}
		const sceneRef = buildSceneRef(input.session, input.event);
		const observationPath = paths.observationPath(sceneRef);
		const observationLines = this.readObservationLines(observationPath);
		if (observationLines.length === 0) {
			return;
		}
		if (!shouldRunFormationForObservations(observationLines, Date.parse(input.event.occurredAt) || Date.now())) {
			return;
		}
		try {
			const snapshot = buildDreamCorpusSnapshot(paths);
			const clone = createMaintenanceClone(paths);
			try {
				const result = await this.executeMaintenanceSession(input.agent, input.effectiveModel, {
					mode: "formation",
					tempPersonaDir: clone.tempPersonaDir,
					maxConsumeObservationLines: observationLines.length,
					allowDeletes: false,
					prompt: buildFormationTurnPrompt({
						sceneRef,
						turnTranscript: input.turnTranscript,
						sceneMemoryPath: buildSceneMemoryPath(sceneRef),
						memoryManifestText: snapshot.memoryManifestText,
					}),
					resolveModel: this.resolveModel.bind(this),
				});
				syncMaintenanceClone(clone.livePersonaDir, clone.tempPersonaDir, result, { allowDeletes: false });
				const consumeCount = Math.max(0, Math.min(observationLines.length, result.finalize.consumeObservationLines ?? 0));
				const remaining = observationLines.slice(consumeCount).join("\n");
				if (remaining.trim().length === 0) {
					rmSync(observationPath, { force: true });
				} else {
					writeTextFile(observationPath, `${remaining}\n`);
				}
				this.store.audit(input.agent.agentId, "persona.formation_applied", {
					sceneRef,
					writes: result.touchedPaths,
					deletes: [],
					consumedObservationLines: consumeCount,
					summary: result.finalize.summary,
				});
			} finally {
				destroyMaintenanceClone(clone.tempRoot);
			}
			this.clearFormationRetryState(paths, sceneRef);
		} catch (error) {
			this.handleFormationFailure(input.agent, paths, sceneRef, observationPath, observationLines, error);
		}
	}

	private async runDream(agent: AgentSpec): Promise<void> {
		const paths = this.ensurePersonaLayout(agent.slug);
		if (!this.resolveModel(agent, undefined)) {
			return;
		}
		this.clearDreamSkipAudit(agent.agentId);
		const snapshot = buildDreamCorpusSnapshot(paths);
		if (snapshot.indexSizeBytes === 0 && snapshot.manifest.length === 0 && snapshot.observations.length === 0) {
			this.auditDreamSkip(agent, "no_memory_files", {});
			return;
		}
		const priorState = this.readDreamState(paths);
		this.writeDreamState(paths, {
			...priorState,
			lastAttemptedAt: new Date().toISOString(),
			lastError: undefined,
		});
		this.store.audit(agent.agentId, "persona.dream_started", {
			corpusSignature: snapshot.corpusSignature,
			peopleFiles: snapshot.manifest.filter((entry) => entry.kind === "people").length,
			sceneFiles: snapshot.manifest.filter((entry) => entry.kind === "scene").length,
			observationFiles: snapshot.observations.length,
		});
		try {
			const clone = createMaintenanceClone(paths);
			try {
				const result = await this.executeMaintenanceSession(agent, undefined, {
					mode: "dream",
					tempPersonaDir: clone.tempPersonaDir,
					maxConsumeObservationLines: 0,
					allowDeletes: true,
					prompt: buildDreamPrompt(snapshot),
					resolveModel: this.resolveModel.bind(this),
				});
				syncMaintenanceClone(clone.livePersonaDir, clone.tempPersonaDir, result, { allowDeletes: true });
				const updatedSnapshot = buildDreamCorpusSnapshot(paths);
				this.store.audit(agent.agentId, "persona.dream_applied", {
					corpusSignature: updatedSnapshot.corpusSignature,
					touchedPaths: result.touchedPaths,
					deletedPaths: result.deletedPaths,
					summary: result.finalize.summary,
				});
				this.writeDreamState(paths, {
					lastAttemptedAt: new Date().toISOString(),
					lastCompletedAt: new Date().toISOString(),
					lastCorpusSignature: updatedSnapshot.corpusSignature,
					lastError: undefined,
				});
			} finally {
				destroyMaintenanceClone(clone.tempRoot);
			}
			this.clearDreamSkipAudit(agent.agentId);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.writeDreamState(paths, {
				...priorState,
				lastAttemptedAt: new Date().toISOString(),
				lastError: message,
			});
			this.store.audit(agent.agentId, "persona.dream_failed", {
				error: message,
				corpusSignature: snapshot.corpusSignature,
			});
		}
	}

	private async runBacklogSweep(agent: AgentSpec): Promise<void> {
		const paths = this.ensurePersonaLayout(agent.slug);
		if (!this.resolveModel(agent, undefined)) {
			return;
		}
		const files = existsSync(paths.observationsDir) ? readdirSync(paths.observationsDir).filter((name) => name.endsWith(".log")).sort() : [];
		for (const file of files) {
			const sceneRef = file.replace(/\.log$/i, "");
			const observationPath = join(paths.observationsDir, file);
			const observationLines = this.readObservationLines(observationPath);
			if (observationLines.length === 0) {
				continue;
			}
			if (!shouldRunFormationForObservations(observationLines, Date.now())) {
				continue;
			}
			try {
				const snapshot = buildDreamCorpusSnapshot(paths);
				const clone = createMaintenanceClone(paths);
				try {
					const result = await this.executeMaintenanceSession(agent, undefined, {
						mode: "formation",
						tempPersonaDir: clone.tempPersonaDir,
						maxConsumeObservationLines: observationLines.length,
						allowDeletes: false,
						prompt: buildFormationBacklogPrompt({
							sceneRef,
							memoryManifestText: snapshot.memoryManifestText,
						}),
						resolveModel: this.resolveModel.bind(this),
					});
					syncMaintenanceClone(clone.livePersonaDir, clone.tempPersonaDir, result, { allowDeletes: false });
					const consumeCount = Math.max(0, Math.min(observationLines.length, result.finalize.consumeObservationLines ?? 0));
					const remaining = observationLines.slice(consumeCount).join("\n");
					if (remaining.trim().length === 0) {
						rmSync(observationPath, { force: true });
					} else {
						writeTextFile(observationPath, `${remaining}\n`);
					}
					this.store.audit(agent.agentId, "persona.formation_applied", {
						sceneRef,
						writes: result.touchedPaths,
						deletes: [],
						consumedObservationLines: consumeCount,
						summary: result.finalize.summary,
					});
				} finally {
					destroyMaintenanceClone(clone.tempRoot);
				}
				this.clearFormationRetryState(paths, sceneRef);
			} catch (error) {
				this.handleFormationFailure(agent, paths, sceneRef, observationPath, observationLines, error);
			}
		}
	}

	private handleFormationFailure(
		agent: AgentSpec,
		paths: PersonaPaths,
		sceneRef: string,
		observationPath: string,
		observationLines: string[],
		error: unknown,
	): void {
		const signature = buildObservationSignature(observationLines);
		const previous = this.readFormationRetryState(paths, sceneRef);
		const attempts = previous?.signature === signature ? previous.attempts + 1 : 1;
		const errorMessage = error instanceof Error ? error.message : String(error);
		this.store.audit(agent.agentId, "persona.formation_failed", {
			sceneRef,
			error: errorMessage,
			attempts,
			observationLineCount: observationLines.length,
			observationSignature: signature,
		});
		if (attempts >= FORMATION_MAX_RETRIES) {
			rmSync(observationPath, { force: true });
			this.clearFormationRetryState(paths, sceneRef);
			this.store.audit(agent.agentId, "persona.formation_discarded", {
				sceneRef,
				error: errorMessage,
				attempts,
				discardedObservationLines: observationLines.length,
				observationSignature: signature,
			});
			return;
		}
		writeJsonFile(paths.formationRetryStatePath(sceneRef), {
			signature,
			attempts,
			updatedAt: new Date().toISOString(),
			lastError: errorMessage,
		} satisfies FormationRetryState);
	}

	private readObservationLines(path: string): string[] {
		return readTextFile(path, "")
			.split(/\r?\n/)
			.map((line) => line.trimEnd())
			.filter((line) => line.length > 0);
	}

	private resolveModel(
		agent: AgentSpec,
		effectiveModel: WorkerPayload["effectiveModel"] | undefined,
	):
		| {
				model: NonNullable<ReturnType<ModelRegistry["find"]>>;
				apiKey?: string;
		  }
		| undefined {
		const provider = effectiveModel?.provider ?? agent.provider;
		const modelId = effectiveModel?.modelId ?? agent.modelId;
		if (!provider || !modelId) {
			return undefined;
		}
		const registry = new ModelRegistry(AuthStorage.inMemory(), this.store.getRuntimeModelsPath(agent.slug));
		const model = registry.find(provider, modelId);
		if (!model) {
			return undefined;
		}
		const modelConfig = this.store.getModelConfig(agent.agentId);
		const apiKey =
			modelConfig?.kind === "custom"
				? this.store.getCustomModelApiKey(agent.agentId)
				: this.store.getProviderKey(agent.agentId, provider) ?? process.env[MODEL_ENV_MAP[provider] ?? ""];
		return { model, apiKey };
	}

	private enqueueMaintenance(agentId: string, task: () => Promise<void>): void {
		const current = this.state.maintenanceLocks.get(agentId) ?? Promise.resolve();
		const next = current
			.catch(() => undefined)
			.then(task)
			.catch((error) => {
				const agent = this.store.getAgentByRef(agentId);
				this.store.audit(agent.agentId, "persona.formation_unhandled_failure", {
					error: error instanceof Error ? error.message : String(error),
				});
			});
		this.state.maintenanceLocks.set(agentId, next);
		void next.finally(() => {
			if (this.state.maintenanceLocks.get(agentId) === next) {
				this.state.maintenanceLocks.delete(agentId);
			}
		});
	}
}
