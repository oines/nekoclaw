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
import { buildObservationSignature, buildSceneMemoryPath, buildSceneRef, collectEventText, formatObservationLine, shouldRunFormationForObservations, takeTailLinesWithinBudget, trimToTokenBudget } from "./observations.js";
import { PersonaPaths } from "./paths.js";
import { selectRelevantPersonaMemories } from "./selector.js";
import { TokenService } from "../token-service.js";
import type { DreamState, FormationRetryState, PersonaMemoryRuntimeState } from "./types.js";

const SELECTED_MEMORY_TOKEN_BUDGET = 800;

type PreparedPersonaMemorySelection = PreparedPersonaContext["selectedMemoryMarkdowns"];

interface PersonaSelectorPrefetchHandle {
	promise: Promise<PreparedPersonaMemorySelection>;
	startedAt: number;
	settled: boolean;
	consumed: boolean;
	result?: PreparedPersonaMemorySelection;
	error?: string;
	manifestCount: number;
}

export class PersonaMemoryService {
	private readonly storePaths = new StorePaths();

	private readonly tokenService: TokenService;

	private readonly state: PersonaMemoryRuntimeState = {
		maintenanceLocks: new Map<string, Promise<void>>(),
		backlogSweepQueued: new Set<string>(),
		dreamQueued: new Set<string>(),
		dreamSkipAuditCache: new Map<string, string>(),
		selectorPrefetches: new Map<string, PersonaSelectorPrefetchHandle>(),
	};

	constructor(private readonly store: JsonNekoclawStore) {
		this.tokenService = new TokenService(store);
	}

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
		effectiveModel?: WorkerPayload["effectiveModel"],
		options?: {
			prefetchJobId?: string;
			allowPrefetchWait?: boolean;
		},
	): Promise<PreparedPersonaContext> {
		const paths = this.ensurePersonaLayout(agent.slug);
		const sceneRef = buildSceneRef(session, event);
		const tokenModel = this.tokenService.resolveEffectiveModel(agent, session);
		const countTextTokens = (value: string) => this.tokenService.countText(tokenModel, value);
		const indexMarkdown = await trimToTokenBudget(readTextFile(paths.indexPath, ""), INDEX_TOKEN_BUDGET, countTextTokens);
		const sceneObservations = await this.readSceneObservations(paths, sceneRef, countTextTokens);
		const selectedMemoryMarkdowns = await this.resolveSelectedMemoryFiles(agent, session, paths, event, effectiveModel, options);
		return {
			indexMarkdown,
			selectedMemoryMarkdowns,
			sceneObservations,
		};
	}

	startSelectorPrefetch(
		agent: AgentSpec,
		session: SessionRecord,
		job: Pick<{ jobId: string; event: InboundMessageEvent }, "jobId" | "event">,
	): void {
		const key = this.selectorPrefetchKey(agent.agentId, job.jobId);
		if (this.state.selectorPrefetches.has(key)) {
			return;
		}
		const paths = this.ensurePersonaLayout(agent.slug);
		const start = this.startSelectorSelection(agent, session, paths, job.event, this.resolveEffectiveModel(agent, session), {
			source: "prefetch",
			prefetchJobId: job.jobId,
		});
		if (!start) {
			return;
		}
		const handle: PersonaSelectorPrefetchHandle = {
			promise: start.promise,
			startedAt: Date.now(),
			settled: false,
			consumed: false,
			manifestCount: start.manifestCount,
		};
		handle.promise
			.then((result) => {
				handle.result = result;
				handle.settled = true;
			})
			.catch((error) => {
				handle.error = error instanceof Error ? error.message : String(error);
				handle.settled = true;
			});
		this.state.selectorPrefetches.set(key, handle);
		this.store.audit(agent.agentId, "persona.selector_prefetch_started", {
			jobId: job.jobId,
			sessionRecordId: session.sessionRecordId,
			manifestCount: start.manifestCount,
		});
	}

	clearSelectorPrefetch(agentId: string, jobId: string): void {
		this.state.selectorPrefetches.delete(this.selectorPrefetchKey(agentId, jobId));
	}

	clearAgentPrefetches(agentId: string): void {
		const prefix = `${agentId}:`;
		for (const key of this.state.selectorPrefetches.keys()) {
			if (key.startsWith(prefix)) {
				this.state.selectorPrefetches.delete(key);
			}
		}
	}

	scheduleFormation(input: {
		agent: AgentSpec;
		session: SessionRecord;
		event: InboundMessageEvent;
		recentTimeline: string;
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
		void this.requestDream(agent, options);
	}

	requestDream(
		agent: AgentSpec,
		options?: { force?: boolean; skipReason?: string },
	): "queued" | "already_queued" | "no_memory_files" | "skipped" {
		if (options?.skipReason) {
			this.auditDreamSkip(agent, options.skipReason, {});
			return "skipped";
		}
		if (this.state.dreamQueued.has(agent.agentId)) {
			this.auditDreamSkip(agent, "already_queued", {});
			return "already_queued";
		}
		const paths = this.ensurePersonaLayout(agent.slug);
		const state = this.readDreamState(paths);
		if (!options?.force && state.lastCompletedAt) {
			const lastCompletedAt = Date.parse(state.lastCompletedAt);
			if (!Number.isNaN(lastCompletedAt) && Date.now() - lastCompletedAt < DREAM_INTERVAL_MS) {
				this.auditDreamSkip(agent, "not_due", { lastCompletedAt: state.lastCompletedAt });
				return "skipped";
			}
		}
		const snapshot = buildDreamCorpusSnapshot(paths);
		if (snapshot.indexSizeBytes === 0 && snapshot.manifest.length === 0 && snapshot.observations.length === 0) {
			this.auditDreamSkip(agent, "no_memory_files", {});
			return "no_memory_files";
		}
		if (!options?.force && state.lastCorpusSignature && state.lastCorpusSignature === snapshot.corpusSignature) {
			this.auditDreamSkip(agent, "no_corpus_change", { corpusSignature: snapshot.corpusSignature });
			return "skipped";
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
		return "queued";
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

	private async readSceneObservations(
		paths: PersonaPaths,
		sceneRef: string,
		countTextTokens: (value: string) => ReturnType<TokenService["countText"]>,
	): Promise<string> {
		return await takeTailLinesWithinBudget(readTextFile(paths.observationPath(sceneRef), ""), undefined, undefined, countTextTokens);
	}

	private async resolveSelectedMemoryFiles(
		agent: AgentSpec,
		session: SessionRecord,
		paths: PersonaPaths,
		event: InboundMessageEvent,
		effectiveModel: WorkerPayload["effectiveModel"] | undefined,
		options:
			| {
					prefetchJobId?: string;
					allowPrefetchWait?: boolean;
			  }
			| undefined,
	): Promise<PreparedPersonaContext["selectedMemoryMarkdowns"]> {
		const prefetchJobId = options?.prefetchJobId;
		if (!prefetchJobId) {
			return await this.selectMemoryFilesInline(agent, session, paths, event, effectiveModel);
		}
		const handle = this.state.selectorPrefetches.get(this.selectorPrefetchKey(agent.agentId, prefetchJobId)) as
			| PersonaSelectorPrefetchHandle
			| undefined;
		if (!handle) {
			return [];
		}
		if (!handle.settled && !options?.allowPrefetchWait) {
			return [];
		}
		if (handle.error) {
			return [];
		}
		try {
			const selected = options?.allowPrefetchWait ? await handle.promise : (handle.result ?? []);
			if (!handle.consumed) {
				handle.consumed = true;
				this.store.audit(agent.agentId, "persona.selector_prefetch_consumed", {
					jobId: prefetchJobId,
					sessionRecordId: session.sessionRecordId,
					waited: Boolean(options?.allowPrefetchWait),
					manifestCount: handle.manifestCount,
					selectedCount: selected.length,
					selectedPaths: selected.map((entry) => entry.path),
				});
				this.store.audit(agent.agentId, "persona.selector_applied", {
					selectedPaths: selected.map((entry) => entry.path),
					selectedCount: selected.length,
					manifestCount: handle.manifestCount,
				});
			}
			return selected;
		} catch {
			return [];
		}
	}

	private async selectMemoryFilesInline(
		agent: AgentSpec,
		session: SessionRecord,
		paths: PersonaPaths,
		event: InboundMessageEvent,
		effectiveModel: WorkerPayload["effectiveModel"] | undefined,
	): Promise<PreparedPersonaContext["selectedMemoryMarkdowns"]> {
		const start = this.startSelectorSelection(agent, session, paths, event, effectiveModel, { source: "inline" });
		if (!start) {
			return [];
		}
		try {
			const selected = await start.promise;
			this.store.audit(agent.agentId, "persona.selector_applied", {
				selectedPaths: selected.map((entry) => entry.path),
				selectedCount: selected.length,
				manifestCount: start.manifestCount,
			});
			return selected;
		} catch {
			return [];
		}
	}

	private scanPersonaMemoryManifest(slug: string) {
		return buildDreamCorpusSnapshot(this.ensurePersonaLayout(slug)).manifest;
	}

	private buildDreamCorpusSnapshot(slug: string) {
		return buildDreamCorpusSnapshot(this.ensurePersonaLayout(slug));
	}

	private startSelectorSelection(
		agent: AgentSpec,
		session: SessionRecord,
		paths: PersonaPaths,
		event: InboundMessageEvent,
		effectiveModel: WorkerPayload["effectiveModel"] | undefined,
		options: {
			source: "inline" | "prefetch";
			prefetchJobId?: string;
		},
	): { manifestCount: number; promise: Promise<PreparedPersonaMemorySelection> } | undefined {
		const manifest = this.scanPersonaMemoryManifest(agent.slug);
		if (manifest.length === 0) {
			return undefined;
		}
		const messageText = this.buildSelectorMessageText(event);
		if (!messageText) {
			return undefined;
		}
		const modelConfig = this.resolveModel(agent, effectiveModel);
		if (!modelConfig) {
			return undefined;
		}
		const tokenModel = this.tokenService.resolveEffectiveModel(agent, session);
		const countTextTokens = (value: string) => this.tokenService.countText(tokenModel, value);
		const manifestByPath = new Map(manifest.map((entry) => [entry.path, entry] as const));
		const promise = (async () => {
			try {
				const result = await selectRelevantPersonaMemories(
					modelConfig.model,
					{
						senderAccount: this.buildSelectorSenderAccount(event),
						senderDisplayName: event.sender.displayName,
						messageText,
						manifest,
					},
					{ apiKey: modelConfig.apiKey },
				);
				const selected = await Promise.all(
					result.paths.map(async (path) => {
						const entry = manifestByPath.get(path);
						if (!entry) {
							return undefined;
						}
						return {
							path: entry.path,
							kind: entry.kind,
							title: entry.title,
							description: entry.description,
							markdown: await trimToTokenBudget(
								readTextFile(join(paths.personaDir, entry.path), ""),
								SELECTED_MEMORY_TOKEN_BUDGET,
								countTextTokens,
							),
						};
					}),
				);
				return selected.filter((entry): entry is PreparedPersonaMemorySelection[number] => Boolean(entry && entry.markdown.trim()));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (message.includes("selector timeout")) {
					if (options.source === "prefetch") {
						this.store.audit(agent.agentId, "persona.selector_prefetch_timeout", {
							jobId: options.prefetchJobId,
							sessionRecordId: session.sessionRecordId,
							manifestCount: manifest.length,
						});
					}
					this.store.audit(agent.agentId, "persona.selector_timeout", {
						manifestCount: manifest.length,
					});
				} else {
					if (options.source === "prefetch") {
						this.store.audit(agent.agentId, "persona.selector_prefetch_failed", {
							jobId: options.prefetchJobId,
							sessionRecordId: session.sessionRecordId,
							error: message,
							manifestCount: manifest.length,
						});
					}
					this.store.audit(agent.agentId, "persona.selector_failed", {
						error: message,
						manifestCount: manifest.length,
					});
				}
				throw error;
			}
		})();
		return {
			manifestCount: manifest.length,
			promise,
		};
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
		recentTimeline: string;
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
						recentTimeline: input.recentTimeline,
						sceneMemoryPath: buildSceneMemoryPath(sceneRef),
						memoryManifestText: snapshot.memoryManifestText,
						channelType: input.session.channelType,
						chatKind: input.session.chatKind,
						chatId: input.session.externalConversationId,
						chatTitle: input.session.chatTitle ?? input.event.chatTitle,
						senderId: input.event.sender.externalId,
						senderDisplayName: input.event.sender.displayName,
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

	private buildSelectorSenderAccount(event: InboundMessageEvent): string {
		const channel = event.channelType === "napcat" ? "qq" : event.channelType;
		return `${channel}:${event.sender.externalId || event.chatId}`;
	}

	private buildSelectorMessageText(event: InboundMessageEvent): string {
		return collectEventText(event)
			.replace(/^- [A-Za-z]+:\s*/gm, "")
			.trim();
	}

	private resolveEffectiveModel(agent: AgentSpec, session: SessionRecord): WorkerPayload["effectiveModel"] | undefined {
		return session.modelOverride
			? {
					provider: session.modelOverride.provider,
					modelId: session.modelOverride.modelId,
					thinkingLevel: agent.thinkingLevel,
				}
			: agent.provider && agent.modelId
				? {
						provider: agent.provider,
						modelId: agent.modelId,
						thinkingLevel: agent.thinkingLevel,
					}
				: undefined;
	}

	private selectorPrefetchKey(agentId: string, jobId: string): string {
		return `${agentId}:${jobId}`;
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
