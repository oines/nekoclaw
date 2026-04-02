import { createHash } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { complete, type Context } from "@mariozechner/pi-ai";
import {
	AuthStorage,
	createAgentSession,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { MODEL_ENV_MAP } from "../model/provider-key.js";
import { summarizeBlocks } from "../messages.js";
import { JsonNekoclawStore } from "../store/json-store.js";
import { ensureParentDir, readJsonFile, readTextFile, removeFileIfExists, withFileLock, writeJsonFile, writeTextFile } from "../store/fs.js";
import type { AgentSpec, InboundMessageEvent, PreparedPersonaContext, ReplyPayload, SessionRecord, WorkerPayload } from "../types.js";

const INDEX_TOKEN_BUDGET = 2_000;
const SCENE_OBSERVATION_MAX_LINES = 80;
const SCENE_OBSERVATION_TOKEN_BUDGET = 1_200;
const MEMORY_FILE_TOKEN_BUDGET = 1_500;
const TOTAL_MEMORY_TOKEN_BUDGET = 3_000;
const MAX_SELECTED_MEMORY_FILES = 3;
const SELECTOR_TIMEOUT_MS = 20_000;
const FORMATION_MIN_OBSERVATION_LINES = 50;
const FORMATION_MAX_WAIT_MS = 30 * 60 * 1_000;
const FORMATION_MAX_RETRIES = 3;
const DREAM_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const DREAM_DOC_EXCERPT_TOKEN_BUDGET = 220;
const DREAM_OBSERVATION_EXCERPT_TOKEN_BUDGET = 180;
const MAINTENANCE_TIMEOUT_MS = 120_000;

const maintenanceLocks = new Map<string, Promise<void>>();
const backlogSweepQueued = new Set<string>();
const dreamQueued = new Set<string>();
const dreamSkipAuditCache = new Map<string, string>();

interface SelectorResult {
	paths: string[];
	notes: string;
}

interface SelectorAttemptResult {
	result?: SelectorResult;
	fallbackReason?: string;
}

interface FormationRetryState {
	signature: string;
	attempts: number;
	updatedAt: string;
	lastError?: string;
}

interface DreamState {
	lastCompletedAt?: string;
	lastAttemptedAt?: string;
	lastCorpusSignature?: string;
	lastError?: string;
}

interface DreamCorpusEntry {
	path: string;
	content: string;
	excerpt: string;
	mtimeMs: number;
	sizeBytes: number;
}

interface DreamObservationEntry {
	path: string;
	content: string;
	excerpt: string;
	lineCount: number;
	mtimeMs: number;
	sizeBytes: number;
}

interface DreamCorpusSnapshot {
	indexMarkdown: string;
	people: DreamCorpusEntry[];
	scenes: DreamCorpusEntry[];
	observations: DreamObservationEntry[];
	corpusSignature: string;
}

interface MaintenanceFinalizeDetails {
	consumeObservationLines?: number;
	summary?: string;
}

interface MaintenanceExecutionResult {
	finalize: MaintenanceFinalizeDetails;
	touchedPaths: string[];
	deletedPaths: string[];
}

const PersonaFinalizeSchema = Type.Object({
	consumeObservationLines: Type.Optional(Type.Number({ description: "How many lines from the current observation backlog were fully incorporated." })),
	summary: Type.Optional(Type.String({ description: "Short summary of what was changed in this maintenance run." })),
});

const DeleteMemoryFileSchema = Type.Object({
	path: Type.String({ description: "Relative path under memory/people or memory/scenes to delete." }),
});

function estimateTokens(value: string): number {
	return Math.ceil(value.length / 4);
}

function trimToTokenBudget(value: string, budget: number): string {
	if (estimateTokens(value) <= budget) {
		return value;
	}
	const lines = value.split(/\r?\n/);
	const kept: string[] = [];
	let used = 0;
	for (const line of lines) {
		const lineCost = estimateTokens(line) + 1;
		if (used + lineCost > budget) {
			break;
		}
		kept.push(line);
		used += lineCost;
	}
	return kept.join("\n").trim();
}

function takeTailLinesWithinBudget(value: string, maxLines: number, tokenBudget: number): string {
	const lines = value
		.split(/\r?\n/)
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0);
	const selected: string[] = [];
	let used = 0;
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index]!;
		const cost = estimateTokens(line) + 1;
		if (selected.length >= maxLines || used + cost > tokenBudget) {
			break;
		}
		selected.unshift(line);
		used += cost;
	}
	return selected.join("\n");
}

function slugSegment(value: string | undefined): string {
	const normalized = (value ?? "unknown")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return normalized || "unknown";
}

function buildSceneRef(session: SessionRecord | undefined, event: InboundMessageEvent): string {
	const threadPart = session?.threadId ? `-${slugSegment(session.threadId)}` : "";
	return `${event.channelType}-${event.chatKind}-${slugSegment(event.chatId)}${threadPart}`;
}

function buildSceneMemoryPath(sceneRef: string): string {
	return `memory/scenes/${sceneRef}.md`;
}

function buildAccountMemoryPath(event: InboundMessageEvent): string {
	const account = `${event.channelType}-${event.sender.externalId ?? event.chatId}`;
	return `memory/people/${slugSegment(account)}.md`;
}

function collectReplyText(payload: ReplyPayload | undefined): string {
	return payload?.text?.trim() || "";
}

function collectEventText(event: InboundMessageEvent): string {
	return summarizeBlocks(event.blocks).join("\n").trim();
}

function extractJsonObject(text: string): string | undefined {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start === -1 || end === -1 || end <= start) {
		return undefined;
	}
	return text.slice(start, end + 1);
}

function normalizeText(value: string | undefined): string {
	return value?.trim() || "";
}

function isAllowedMemoryPath(value: string): boolean {
	return (
		!value.includes("..") &&
		(value.startsWith("memory/people/") || value.startsWith("memory/scenes/")) &&
		value.endsWith(".md")
	);
}

function isIndexPath(value: string): boolean {
	return value === "index.md";
}

function isObservationPath(value: string): boolean {
	return !value.includes("..") && value.startsWith("observations/") && value.endsWith(".log");
}

function normalizeRelativeMaintenancePath(baseDir: string, inputPath: string): string {
	const absolutePath = resolve(baseDir, inputPath);
	const relativePath = relative(baseDir, absolutePath).replace(/\\/g, "/");
	if (relativePath === "" || relativePath.startsWith("../") || relativePath === "..") {
		throw new Error(`Path "${inputPath}" is outside the persona workspace.`);
	}
	return relativePath;
}

function assertReadableMaintenancePath(relativePath: string): void {
	if (isIndexPath(relativePath) || isAllowedMemoryPath(relativePath) || isObservationPath(relativePath)) {
		return;
	}
	throw new Error(`Read is only allowed for index.md, memory/**, and observations/**. Received "${relativePath}".`);
}

function assertEditableMaintenancePath(relativePath: string): void {
	if (isIndexPath(relativePath) || isAllowedMemoryPath(relativePath)) {
		return;
	}
	throw new Error(`Edit is only allowed for index.md and memory/people|scenes markdown files. Received "${relativePath}".`);
}

function assertWritableMaintenancePath(relativePath: string): void {
	if (!isAllowedMemoryPath(relativePath) || isIndexPath(relativePath)) {
		throw new Error(`Write is only allowed for new memory/people or memory/scenes markdown files. Received "${relativePath}".`);
	}
}

function assertDeletableMaintenancePath(relativePath: string): void {
	if (!isAllowedMemoryPath(relativePath)) {
		throw new Error(`Delete is only allowed for memory/people or memory/scenes markdown files. Received "${relativePath}".`);
	}
}

function listMarkdownFiles(dir: string, baseDir: string): string[] {
	if (!existsSync(dir)) {
		return [];
	}
	const entries = readdirSync(dir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const absolute = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...listMarkdownFiles(absolute, baseDir));
			continue;
		}
		if (entry.isFile() && entry.name.endsWith(".md")) {
			files.push(relative(baseDir, absolute).replace(/\\/g, "/"));
		}
	}
	return files.sort();
}

function listFilesWithExtension(dir: string, baseDir: string, extension: string): string[] {
	if (!existsSync(dir)) {
		return [];
	}
	return readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(extension))
		.map((entry) => relative(baseDir, join(dir, entry.name)).replace(/\\/g, "/"))
		.sort();
}

function safeJoinPersonaPath(personaDir: string, relativePath: string): string {
	return join(personaDir, relativePath);
}

function formatObservationLine(event: InboundMessageEvent): string {
	const speaker = `${event.channelType}:${event.sender.externalId ?? event.chatId}`;
	const displayName = event.sender.displayName ? ` ${event.sender.displayName}` : "";
	const content = collectEventText(event).replace(/\n+/g, " ").trim();
	return `[${event.occurredAt}] ${speaker}${displayName}: ${content}`;
}

function parseObservationTimestamp(line: string): number | undefined {
	const match = line.match(/^\[([^\]]+)\]/);
	if (!match?.[1]) {
		return undefined;
	}
	const timestamp = Date.parse(match[1]);
	return Number.isNaN(timestamp) ? undefined : timestamp;
}

function shouldRunFormationForObservations(observationLines: string[], referenceTimeMs: number): boolean {
	if (observationLines.length === 0) {
		return false;
	}
	if (observationLines.length >= FORMATION_MIN_OBSERVATION_LINES) {
		return true;
	}
	const oldestTimestamp = parseObservationTimestamp(observationLines[0]!);
	if (oldestTimestamp === undefined) {
		return true;
	}
	return referenceTimeMs - oldestTimestamp >= FORMATION_MAX_WAIT_MS;
}

function buildObservationSignature(observationLines: string[]): string {
	return createHash("sha256").update(observationLines.join("\n")).digest("hex");
}

function fallbackSelector(
	indexMarkdown: string,
	sceneObservations: string,
	currentMessage: string,
	candidateContents: Array<{ path: string; content: string }>,
): SelectorResult {
	const haystack = `${indexMarkdown}\n${sceneObservations}\n${currentMessage}`.toLowerCase();
	const scored = candidateContents
		.map((candidate) => {
			const basename = candidate.path.split("/").pop()?.replace(/\.md$/i, "") ?? candidate.path;
			let score = 0;
			for (const token of Array.from(new Set(haystack.split(/[^a-z0-9\u4e00-\u9fff]+/i).filter((value) => value.length >= 2)))) {
				if (candidate.content.toLowerCase().includes(token)) {
					score += 2;
				}
				if (basename.toLowerCase().includes(token)) {
					score += 3;
				}
			}
			return { path: candidate.path, score };
		})
		.filter((candidate) => candidate.score > 0)
		.sort((left, right) => right.score - left.score)
		.slice(0, MAX_SELECTED_MEMORY_FILES);
	return {
		paths: scored.map((entry) => entry.path),
		notes: scored.length > 0 ? "Used heuristic selector fallback." : "No detailed memory files selected.",
	};
}

function buildDreamSkipKey(reason: string, details: Record<string, unknown>): string {
	return JSON.stringify({ reason, ...details });
}

async function extractCompletionText(
	model: NonNullable<ReturnType<ModelRegistry["find"]>>,
	apiKey: string | undefined,
	context: Context,
): Promise<string> {
	const response = await complete(model, context, apiKey ? { apiKey } : undefined);
	return response.content
		.filter((block): block is Extract<(typeof response.content)[number], { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	return await new Promise<T>((resolve, reject) => {
		const timeout = setTimeout(() => {
			reject(new Error(message));
		}, timeoutMs);
		timeout.unref?.();
		void promise
			.then((value) => {
				clearTimeout(timeout);
				resolve(value);
			})
			.catch((error) => {
				clearTimeout(timeout);
				reject(error);
			});
	});
}

class SelectorTimeoutError extends Error {
	constructor() {
		super(`Selector timed out after ${SELECTOR_TIMEOUT_MS}ms.`);
		this.name = "SelectorTimeoutError";
	}
}

export class PersonaMemoryService {
	constructor(private readonly store: JsonNekoclawStore) {}

	recordInbound(agentId: string, session: SessionRecord | undefined, event: InboundMessageEvent): void {
		const agent = this.store.getAgentByRef(agentId);
		this.ensurePersonaLayout(agent.slug);
		const sceneRef = buildSceneRef(session, event);
		const path = this.store.getPersonaObservationPath(agent.slug, sceneRef);
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
	): Promise<PreparedPersonaContext> {
		this.ensurePersonaLayout(agent.slug);
		const personaDir = this.store.getPersonaDir(agent.slug);
		const sceneRef = buildSceneRef(session, event);
		const indexMarkdown = trimToTokenBudget(
			readTextFile(this.store.getPersonaIndexPath(agent.slug), ""),
			INDEX_TOKEN_BUDGET,
		);
		const sceneObservations = this.readSceneObservations(agent.slug, sceneRef);
		const candidatePaths = [
			...listMarkdownFiles(this.store.getPersonaPeopleDir(agent.slug), personaDir),
			...listMarkdownFiles(this.store.getPersonaScenesDir(agent.slug), personaDir),
		];
		const candidateContents = candidatePaths.map((path) => ({
			path,
			content: readTextFile(safeJoinPersonaPath(personaDir, path), ""),
		}));
		const selectorAttempt = await this.runSelector(agent, effectiveModel, {
			indexMarkdown,
			sceneObservations,
			currentMessage: collectEventText(event),
			candidatePaths,
			candidateContents,
			sessionKey: session.sessionKey,
			sceneRef,
		});
		const selector =
			selectorAttempt.result ?? fallbackSelector(indexMarkdown, sceneObservations, collectEventText(event), candidateContents);
		if (!selectorAttempt.result) {
			this.store.audit(agent.agentId, "persona.selector_fallback_used", {
				sessionKey: session.sessionKey,
				sceneRef,
				candidateCount: candidatePaths.length,
				selectedCount: selector.paths.length,
				reason: selectorAttempt.fallbackReason ?? "unknown",
			});
		}

		const selectedMemories: PreparedPersonaContext["selectedMemories"] = [];
		let usedBudget = 0;
		for (const path of selector.paths) {
			const match = candidateContents.find((candidate) => candidate.path === path);
			if (!match) {
				continue;
			}
			const trimmed = trimToTokenBudget(match.content, MEMORY_FILE_TOKEN_BUDGET);
			const cost = estimateTokens(trimmed);
			if (!trimmed || usedBudget + cost > TOTAL_MEMORY_TOKEN_BUDGET) {
				continue;
			}
			selectedMemories.push({ path, content: trimmed });
			usedBudget += cost;
			if (selectedMemories.length >= MAX_SELECTED_MEMORY_FILES) {
				break;
			}
		}

		return {
			indexMarkdown,
			sceneObservations,
			selectedMemories,
			selectionNotes: selector.notes,
		};
	}

	scheduleFormation(input: {
		agent: AgentSpec;
		session: SessionRecord;
		event: InboundMessageEvent;
		replyText: string;
		personaContext: PreparedPersonaContext;
		effectiveModel?: WorkerPayload["effectiveModel"];
	}): void {
		this.enqueueMaintenance(input.agent.agentId, async () => {
			await this.runFormationForTurn(input);
		});
	}

	queueBacklogSweep(agent: AgentSpec): void {
		if (backlogSweepQueued.has(agent.agentId)) {
			return;
		}
		backlogSweepQueued.add(agent.agentId);
		this.enqueueMaintenance(agent.agentId, async () => {
			try {
				await this.runBacklogSweep(agent);
			} finally {
				backlogSweepQueued.delete(agent.agentId);
			}
		});
	}

	queueDream(agent: AgentSpec, options?: { force?: boolean; skipReason?: string }): void {
		if (options?.skipReason) {
			this.auditDreamSkip(agent, options.skipReason, {});
			return;
		}
		if (dreamQueued.has(agent.agentId)) {
			this.auditDreamSkip(agent, "already_queued", {});
			return;
		}
		this.ensurePersonaLayout(agent.slug);
		const state = this.readDreamState(agent.slug);
		if (!options?.force && state.lastCompletedAt) {
			const lastCompletedAt = Date.parse(state.lastCompletedAt);
			if (!Number.isNaN(lastCompletedAt) && Date.now() - lastCompletedAt < DREAM_INTERVAL_MS) {
				this.auditDreamSkip(agent, "not_due", { lastCompletedAt: state.lastCompletedAt });
				return;
			}
		}
		const snapshot = this.buildDreamCorpusSnapshot(agent.slug);
		if (
			snapshot.indexMarkdown.trim().length === 0 &&
			snapshot.people.length === 0 &&
			snapshot.scenes.length === 0 &&
			snapshot.observations.length === 0
		) {
			this.auditDreamSkip(agent, "no_memory_files", {});
			return;
		}
		if (!options?.force && state.lastCorpusSignature && state.lastCorpusSignature === snapshot.corpusSignature) {
			this.auditDreamSkip(agent, "no_corpus_change", { corpusSignature: snapshot.corpusSignature });
			return;
		}
		dreamQueued.add(agent.agentId);
		dreamSkipAuditCache.delete(agent.agentId);
		this.store.audit(agent.agentId, "persona.dream_queued", {
			corpusSignature: snapshot.corpusSignature,
			peopleFiles: snapshot.people.length,
			sceneFiles: snapshot.scenes.length,
			observationFiles: snapshot.observations.length,
		});
		this.enqueueMaintenance(agent.agentId, async () => {
			try {
				await this.runDream(agent);
			} finally {
				dreamQueued.delete(agent.agentId);
			}
		});
	}

	noteDreamSkip(agent: AgentSpec, reason: "agent_busy"): void {
		this.auditDreamSkip(agent, reason, {});
	}

	whenIdle(agentId: string): Promise<void> {
		return (maintenanceLocks.get(agentId) ?? Promise.resolve()).catch(() => undefined);
	}

	private ensurePersonaLayout(slug: string): void {
		for (const dir of [
			this.store.getPersonaDir(slug),
			this.store.getPersonaPeopleDir(slug),
			this.store.getPersonaScenesDir(slug),
			this.store.getPersonaObservationsDir(slug),
			this.store.getPersonaControlDir(slug),
			this.getFormationRetryDir(slug),
		]) {
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
		}
		const indexPath = this.store.getPersonaIndexPath(slug);
		if (!existsSync(indexPath)) {
			writeTextFile(indexPath, "");
		}
	}

	private readSceneObservations(slug: string, sceneRef: string): string {
		const path = this.store.getPersonaObservationPath(slug, sceneRef);
		return takeTailLinesWithinBudget(readTextFile(path, ""), SCENE_OBSERVATION_MAX_LINES, SCENE_OBSERVATION_TOKEN_BUDGET);
	}

	private getFormationRetryDir(slug: string): string {
		return join(this.store.getPersonaDir(slug), "control", "formation-retries");
	}

	private getFormationRetryStatePath(slug: string, sceneRef: string): string {
		return join(this.getFormationRetryDir(slug), `${sceneRef}.json`);
	}

	private readFormationRetryState(slug: string, sceneRef: string): FormationRetryState | undefined {
		const path = this.getFormationRetryStatePath(slug, sceneRef);
		if (!existsSync(path)) {
			return undefined;
		}
		const state = readJsonFile<FormationRetryState | undefined>(path, undefined);
		if (!state?.signature || typeof state.attempts !== "number") {
			return undefined;
		}
		return state;
	}

	private clearFormationRetryState(slug: string, sceneRef: string): void {
		removeFileIfExists(this.getFormationRetryStatePath(slug, sceneRef));
	}

	private readDreamState(slug: string): DreamState {
		return readJsonFile<DreamState>(this.store.getPersonaDreamStatePath(slug), {});
	}

	private writeDreamState(slug: string, state: DreamState): void {
		writeJsonFile(this.store.getPersonaDreamStatePath(slug), state);
	}

	private async runSelector(
		agent: AgentSpec,
		effectiveModel: WorkerPayload["effectiveModel"] | undefined,
		input: {
			indexMarkdown: string;
			sceneObservations: string;
			currentMessage: string;
			candidatePaths: string[];
			candidateContents: Array<{ path: string; content: string }>;
			sessionKey: string;
			sceneRef: string;
		},
	): Promise<SelectorAttemptResult> {
		if (input.candidatePaths.length === 0) {
			return {
				result: {
					paths: [],
					notes: "No detailed memory files available yet.",
				},
			};
		}
		const modelConfig = this.resolveModel(agent, effectiveModel);
		if (!modelConfig) {
			return { fallbackReason: "model_unavailable" };
		}
		const startedAt = Date.now();
		this.store.audit(agent.agentId, "persona.selector_started", {
			sessionKey: input.sessionKey,
			sceneRef: input.sceneRef,
			candidateCount: input.candidatePaths.length,
		});
		const context: Context = {
			systemPrompt: [
				"你是 Nekoclaw 的人物记忆正文选择器。",
				"你的任务是根据 index、当前消息、当前场景旁观记录，决定是否需要读取哪些详细记忆正文文件。",
				"index.md 永远常驻，所以除非真的需要细节，否则不要选正文。",
				`最多选择 ${MAX_SELECTED_MEMORY_FILES} 个文件，只能从给定候选路径中选。`,
				"如果不需要正文，返回空数组。",
				"输出必须是 JSON：{\"paths\":[...],\"notes\":\"...\"}。",
			].join("\n"),
			messages: [
				{
					role: "user",
					content: [
						`当前消息：\n${input.currentMessage || "(empty)"}`,
						`index.md：\n${input.indexMarkdown || "(empty)"}`,
						`当前场景 observations：\n${input.sceneObservations || "(empty)"}`,
						`可选正文路径：\n${input.candidatePaths.map((path) => `- ${path}`).join("\n")}`,
					].join("\n\n"),
					timestamp: Date.now(),
				},
			],
		};
		try {
			const raw = await new Promise<string>((resolve, reject) => {
				const timeout = setTimeout(() => {
					reject(new SelectorTimeoutError());
				}, SELECTOR_TIMEOUT_MS);
				timeout.unref?.();
				void extractCompletionText(modelConfig.model, modelConfig.apiKey, context)
					.then((value) => {
						clearTimeout(timeout);
						resolve(value);
					})
					.catch((error) => {
						clearTimeout(timeout);
						reject(error);
					});
			});
			const json = extractJsonObject(raw);
			if (!json) {
				const durationMs = Date.now() - startedAt;
				this.store.audit(agent.agentId, "persona.selector_failed", {
					sessionKey: input.sessionKey,
					sceneRef: input.sceneRef,
					candidateCount: input.candidatePaths.length,
					durationMs,
					reason: "missing_json",
				});
				return { fallbackReason: "missing_json" };
			}
			let parsed: Partial<SelectorResult>;
			try {
				parsed = JSON.parse(json) as Partial<SelectorResult>;
			} catch (error) {
				const durationMs = Date.now() - startedAt;
				this.store.audit(agent.agentId, "persona.selector_failed", {
					sessionKey: input.sessionKey,
					sceneRef: input.sceneRef,
					candidateCount: input.candidatePaths.length,
					durationMs,
					reason: "invalid_json",
					error: error instanceof Error ? error.message : String(error),
				});
				return { fallbackReason: "invalid_json" };
			}
			const allowed = new Set(input.candidatePaths);
			const paths = (parsed.paths ?? [])
				.filter((path): path is string => typeof path === "string")
				.filter((path) => allowed.has(path))
				.slice(0, MAX_SELECTED_MEMORY_FILES);
			const durationMs = Date.now() - startedAt;
			this.store.audit(agent.agentId, "persona.selector_completed", {
				sessionKey: input.sessionKey,
				sceneRef: input.sceneRef,
				candidateCount: input.candidatePaths.length,
				selectedCount: paths.length,
				durationMs,
			});
			return {
				result: {
					paths,
					notes: normalizeText(parsed.notes) || "Selected detailed memories using the model.",
				},
			};
		} catch (error) {
			const durationMs = Date.now() - startedAt;
			if (error instanceof SelectorTimeoutError) {
				this.store.audit(agent.agentId, "persona.selector_timed_out", {
					sessionKey: input.sessionKey,
					sceneRef: input.sceneRef,
					candidateCount: input.candidatePaths.length,
					durationMs,
					reason: "timeout",
				});
				return { fallbackReason: "timeout" };
			}
			this.store.audit(agent.agentId, "persona.selector_failed", {
				sessionKey: input.sessionKey,
				sceneRef: input.sceneRef,
				candidateCount: input.candidatePaths.length,
				durationMs,
				reason: "model_error",
				error: error instanceof Error ? error.message : String(error),
			});
			return { fallbackReason: "model_error" };
		}
	}

	private buildDreamCorpusSnapshot(slug: string): DreamCorpusSnapshot {
		this.ensurePersonaLayout(slug);
		const personaDir = this.store.getPersonaDir(slug);
		const people = listMarkdownFiles(this.store.getPersonaPeopleDir(slug), personaDir).map((path) => this.readDreamCorpusEntry(personaDir, path));
		const scenes = listMarkdownFiles(this.store.getPersonaScenesDir(slug), personaDir).map((path) => this.readDreamCorpusEntry(personaDir, path));
		const observations = listFilesWithExtension(this.store.getPersonaObservationsDir(slug), personaDir, ".log").map((path) =>
			this.readDreamObservationEntry(personaDir, path),
		);
		const indexMarkdown = readTextFile(this.store.getPersonaIndexPath(slug), "");
		const signatureSeed = [
			`index:${indexMarkdown}`,
			...people.map((entry) => `${entry.path}:${entry.content}`),
			...scenes.map((entry) => `${entry.path}:${entry.content}`),
			...observations.map((entry) => `${entry.path}:${entry.content}`),
		].join("\n\n");
		return {
			indexMarkdown,
			people,
			scenes,
			observations,
			corpusSignature: createHash("sha256").update(signatureSeed).digest("hex"),
		};
	}

	private readDreamCorpusEntry(personaDir: string, relativePath: string): DreamCorpusEntry {
		const absolutePath = safeJoinPersonaPath(personaDir, relativePath);
		const content = readTextFile(absolutePath, "");
		const stats = statSync(absolutePath);
		return {
			path: relativePath,
			content,
			excerpt: trimToTokenBudget(content, DREAM_DOC_EXCERPT_TOKEN_BUDGET),
			mtimeMs: stats.mtimeMs,
			sizeBytes: stats.size,
		};
	}

	private readDreamObservationEntry(personaDir: string, relativePath: string): DreamObservationEntry {
		const absolutePath = safeJoinPersonaPath(personaDir, relativePath);
		const content = readTextFile(absolutePath, "");
		const stats = statSync(absolutePath);
		const lines = content
			.split(/\r?\n/)
			.map((line) => line.trimEnd())
			.filter((line) => line.length > 0);
		return {
			path: relativePath,
			content,
			excerpt: takeTailLinesWithinBudget(content, 24, DREAM_OBSERVATION_EXCERPT_TOKEN_BUDGET),
			lineCount: lines.length,
			mtimeMs: stats.mtimeMs,
			sizeBytes: stats.size,
		};
	}

	private auditDreamSkip(agent: AgentSpec, reason: string, details: Record<string, unknown>): void {
		const cacheKey = buildDreamSkipKey(reason, details);
		if (dreamSkipAuditCache.get(agent.agentId) === cacheKey) {
			return;
		}
		dreamSkipAuditCache.set(agent.agentId, cacheKey);
		this.store.audit(agent.agentId, "persona.dream_skipped", {
			reason,
			...details,
		});
	}

	private clearDreamSkipAudit(agentId: string): void {
		dreamSkipAuditCache.delete(agentId);
	}

	private createMaintenanceClone(slug: string): { tempRoot: string; tempPersonaDir: string; livePersonaDir: string } {
		this.ensurePersonaLayout(slug);
		const tempRoot = mkdtempSync(join(tmpdir(), "nekoclaw-persona-maint-"));
		const tempPersonaDir = join(tempRoot, ".nekoclaw-persona");
		const livePersonaDir = this.store.getPersonaDir(slug);
		cpSync(livePersonaDir, tempPersonaDir, { recursive: true, force: true });
		return { tempRoot, tempPersonaDir, livePersonaDir };
	}

	private syncMaintenanceClone(
		slug: string,
		livePersonaDir: string,
		tempPersonaDir: string,
		result: MaintenanceExecutionResult,
		options: { allowDeletes: boolean },
	): void {
		this.ensurePersonaLayout(slug);
		const uniqueTouched = Array.from(new Set(result.touchedPaths));
		for (const relativePath of uniqueTouched) {
			if (!isIndexPath(relativePath) && !isAllowedMemoryPath(relativePath)) {
				continue;
			}
			const tempPath = safeJoinPersonaPath(tempPersonaDir, relativePath);
			if (!existsSync(tempPath)) {
				continue;
			}
			writeTextFile(safeJoinPersonaPath(livePersonaDir, relativePath), readTextFile(tempPath, ""));
		}
		if (!options.allowDeletes) {
			return;
		}
		for (const relativePath of Array.from(new Set(result.deletedPaths))) {
			if (!isAllowedMemoryPath(relativePath)) {
				continue;
			}
			removeFileIfExists(safeJoinPersonaPath(livePersonaDir, relativePath));
		}
	}

	private async executeMaintenanceSession(
		agent: AgentSpec,
		effectiveModel: WorkerPayload["effectiveModel"] | undefined,
		input: {
			mode: "formation" | "dream";
			tempPersonaDir: string;
			prompt: string;
			maxConsumeObservationLines: number;
			allowDeletes: boolean;
		},
	): Promise<MaintenanceExecutionResult> {
		const modelConfig = this.resolveModel(agent, effectiveModel);
		if (!modelConfig) {
			throw new Error("No configured model available for persona maintenance.");
		}
		const authStorage = AuthStorage.inMemory();
		if (modelConfig.apiKey) {
			authStorage.setRuntimeApiKey(modelConfig.model.provider, modelConfig.apiKey);
		}
		const runtimeAgentDir = join(input.tempPersonaDir, ".maintenance-runtime");
		const settingsManager = SettingsManager.inMemory({
			compaction: {
				enabled: false,
			},
		});
		const modelRegistry = new ModelRegistry(authStorage, join(runtimeAgentDir, "models.json"));
		const resourceLoader = new DefaultResourceLoader({
			cwd: input.tempPersonaDir,
			agentDir: runtimeAgentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			systemPrompt: [
				input.mode === "dream"
					? "You are Nekoclaw Dream, a global persona memory maintainer."
					: "You are Nekoclaw formation, a scene-local persona memory maintainer.",
				"You are working inside a temporary clone of .nekoclaw-persona.",
				"Use read/edit/write tools to maintain index.md and memory markdown files directly.",
				"Existing files must be revised with edit. Use write only to create a new memory/people or memory/scenes file that does not exist yet.",
				input.mode === "dream"
					? "Dream may delete low-value memory/people or memory/scenes files when forgetting is appropriate, but it must preserve corrections, confirmed identity links, core relationships, and long-term background."
					: "Formation must not delete any files.",
				"Never modify observations/ or control/. Observations are evidence only.",
				"Do not invent facts. Preserve uncertainty and preserve whether you only observed something or participated in it.",
				"Before you finish, you must call persona_finalize exactly once.",
			].join("\n"),
			agentsFilesOverride: () => ({ agentsFiles: [] }),
		});
		await resourceLoader.reload();

		const touchedPaths = new Set<string>();
		const deletedPaths = new Set<string>();
		let finalizeCount = 0;
		let finalize: MaintenanceFinalizeDetails | undefined;

		const readTool = createReadToolDefinition(input.tempPersonaDir, {
			operations: {
				access: async (absolutePath) => {
					const relativePath = normalizeRelativeMaintenancePath(input.tempPersonaDir, absolutePath);
					assertReadableMaintenancePath(relativePath);
				},
				readFile: async (absolutePath) => {
					const relativePath = normalizeRelativeMaintenancePath(input.tempPersonaDir, absolutePath);
					assertReadableMaintenancePath(relativePath);
					return await import("node:fs/promises").then((fs) => fs.readFile(absolutePath));
				},
			},
		});
		const editTool = createEditToolDefinition(input.tempPersonaDir, {
			operations: {
				access: async (absolutePath) => {
					const relativePath = normalizeRelativeMaintenancePath(input.tempPersonaDir, absolutePath);
					assertEditableMaintenancePath(relativePath);
					if (!existsSync(absolutePath)) {
						throw new Error(`Edit target "${relativePath}" does not exist.`);
					}
				},
				readFile: async (absolutePath) => {
					const relativePath = normalizeRelativeMaintenancePath(input.tempPersonaDir, absolutePath);
					assertEditableMaintenancePath(relativePath);
					return await import("node:fs/promises").then((fs) => fs.readFile(absolutePath));
				},
				writeFile: async (absolutePath, content) => {
					const relativePath = normalizeRelativeMaintenancePath(input.tempPersonaDir, absolutePath);
					assertEditableMaintenancePath(relativePath);
					touchedPaths.add(relativePath);
					await import("node:fs/promises").then((fs) => fs.writeFile(absolutePath, content, "utf-8"));
				},
			},
		});
		const writeTool = createWriteToolDefinition(input.tempPersonaDir, {
			operations: {
				mkdir: async (dir) => {
					const relativePath = normalizeRelativeMaintenancePath(input.tempPersonaDir, dir);
					if (relativePath !== "memory/people" && relativePath !== "memory/scenes" && !relativePath.startsWith("memory/people/") && !relativePath.startsWith("memory/scenes/")) {
						throw new Error(`Write can only create files under memory/people or memory/scenes. Received directory "${relativePath}".`);
					}
					await import("node:fs/promises").then((fs) => fs.mkdir(dir, { recursive: true }));
				},
				writeFile: async (absolutePath, content) => {
					const relativePath = normalizeRelativeMaintenancePath(input.tempPersonaDir, absolutePath);
					assertWritableMaintenancePath(relativePath);
					if (existsSync(absolutePath)) {
						throw new Error(`Write may only create new files. "${relativePath}" already exists; use edit instead.`);
					}
					touchedPaths.add(relativePath);
					await import("node:fs/promises").then((fs) => fs.writeFile(absolutePath, content, "utf-8"));
				},
			},
		});

		const customTools: Array<ToolDefinition<any, any, any>> = [
			readTool,
			editTool,
			writeTool,
			{
				name: "persona_finalize",
				label: "Finalize Persona Maintenance",
				description: "Finalize this maintenance run exactly once after all file edits are complete.",
				parameters: PersonaFinalizeSchema,
				execute: async (_toolCallId, params: { consumeObservationLines?: number; summary?: string }) => {
					finalizeCount += 1;
					if (finalizeCount > 1) {
						throw new Error("persona_finalize may only be called once.");
					}
					finalize = {
						consumeObservationLines:
							input.mode === "dream"
								? 0
								: Math.max(
										0,
										Math.min(
											input.maxConsumeObservationLines,
											Math.floor(Number(params.consumeObservationLines ?? 0) || 0),
										),
									),
						summary: normalizeText(params.summary),
					};
					return {
						content: [{ type: "text", text: "Persona maintenance finalized." }],
						details: {},
					};
				},
			},
		];
		if (input.allowDeletes) {
			customTools.push({
				name: "delete_memory_file",
				label: "Delete Memory File",
				description: "Delete an existing memory/people or memory/scenes markdown file when Dream decides it should be forgotten.",
				parameters: DeleteMemoryFileSchema,
				execute: async (_toolCallId, params: { path: string }) => {
					const relativePath = normalizeRelativeMaintenancePath(input.tempPersonaDir, params.path);
					assertDeletableMaintenancePath(relativePath);
					const absolutePath = safeJoinPersonaPath(input.tempPersonaDir, relativePath);
					if (!existsSync(absolutePath)) {
						throw new Error(`Cannot delete "${relativePath}" because it does not exist.`);
					}
					deletedPaths.add(relativePath);
					rmSync(absolutePath, { force: true });
					return {
						content: [{ type: "text", text: `Deleted ${relativePath}.` }],
						details: {},
					};
				},
			});
		}

		const { session } = await createAgentSession({
			cwd: input.tempPersonaDir,
			agentDir: runtimeAgentDir,
			authStorage,
			modelRegistry,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
			model: modelConfig.model,
			thinkingLevel: effectiveModel?.thinkingLevel ?? agent.thinkingLevel,
			tools: [],
			customTools,
		});
		await withTimeout(session.prompt(input.prompt), MAINTENANCE_TIMEOUT_MS, `Persona maintenance timed out after ${MAINTENANCE_TIMEOUT_MS}ms.`);
		if (finalizeCount !== 1 || !finalize) {
			throw new Error(`persona_finalize must be called exactly once; saw ${finalizeCount}.`);
		}
		return {
			finalize,
			touchedPaths: Array.from(touchedPaths),
			deletedPaths: Array.from(deletedPaths),
		};
	}

	private async runFormationForTurn(input: {
		agent: AgentSpec;
		session: SessionRecord;
		event: InboundMessageEvent;
		replyText: string;
		personaContext: PreparedPersonaContext;
		effectiveModel?: WorkerPayload["effectiveModel"];
	}): Promise<void> {
		this.ensurePersonaLayout(input.agent.slug);
		if (!this.resolveModel(input.agent, input.effectiveModel)) {
			return;
		}
		const sceneRef = buildSceneRef(input.session, input.event);
		const observationPath = this.store.getPersonaObservationPath(input.agent.slug, sceneRef);
		const observationLines = this.readObservationLines(observationPath);
		if (observationLines.length === 0) {
			return;
		}
		if (!shouldRunFormationForObservations(observationLines, Date.parse(input.event.occurredAt) || Date.now())) {
			return;
		}
		try {
			const clone = this.createMaintenanceClone(input.agent.slug);
			try {
				const result = await this.executeMaintenanceSession(input.agent, input.effectiveModel, {
					mode: "formation",
					tempPersonaDir: clone.tempPersonaDir,
					maxConsumeObservationLines: observationLines.length,
					allowDeletes: false,
					prompt: [
						`Maintain persona memory for scene ${sceneRef}.`,
						"",
						"Use tools to inspect and revise the temporary persona workspace.",
						"Required files to inspect:",
						"- index.md",
						`- observations/${sceneRef}.log`,
						...input.personaContext.selectedMemories.map((doc) => `- ${doc.path}`),
						`- ${buildSceneMemoryPath(sceneRef)} (if it exists)`,
						"",
						`Current inbound message:\n${collectEventText(input.event) || "(empty)"}`,
						"",
						`Actual reply that was sent:\n${input.replyText || "(none)"}`,
						"",
						"Goals:",
						"- Preserve persona memory as Markdown prose.",
						"- Update index.md and any relevant people/scenes files using edit.",
						"- You may create a new people/scenes file with write if needed.",
						"- Do not delete files.",
						"- Preserve corrections, identity links, uncertainty, and whether you observed or participated.",
						"- When you finish, call persona_finalize with the number of observation lines from this scene log that were fully incorporated.",
					].join("\n"),
				});
				this.syncMaintenanceClone(input.agent.slug, clone.livePersonaDir, clone.tempPersonaDir, result, { allowDeletes: false });
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
				rmSync(clone.tempRoot, { recursive: true, force: true });
			}
			this.clearFormationRetryState(input.agent.slug, sceneRef);
		} catch (error) {
			this.handleFormationFailure(input.agent, sceneRef, observationPath, observationLines, error);
		}
	}

	private async runDream(agent: AgentSpec): Promise<void> {
		this.ensurePersonaLayout(agent.slug);
		if (!this.resolveModel(agent, undefined)) {
			return;
		}
		this.clearDreamSkipAudit(agent.agentId);
		const snapshot = this.buildDreamCorpusSnapshot(agent.slug);
		if (
			snapshot.indexMarkdown.trim().length === 0 &&
			snapshot.people.length === 0 &&
			snapshot.scenes.length === 0 &&
			snapshot.observations.length === 0
		) {
			this.auditDreamSkip(agent, "no_memory_files", {});
			return;
		}
		const priorState = this.readDreamState(agent.slug);
		this.writeDreamState(agent.slug, {
			...priorState,
			lastAttemptedAt: new Date().toISOString(),
			lastError: undefined,
		});
		this.store.audit(agent.agentId, "persona.dream_started", {
			corpusSignature: snapshot.corpusSignature,
			peopleFiles: snapshot.people.length,
			sceneFiles: snapshot.scenes.length,
			observationFiles: snapshot.observations.length,
		});
		try {
			const clone = this.createMaintenanceClone(agent.slug);
			try {
				const result = await this.executeMaintenanceSession(agent, undefined, {
					mode: "dream",
					tempPersonaDir: clone.tempPersonaDir,
					maxConsumeObservationLines: 0,
					allowDeletes: true,
					prompt: [
						"Perform a Dream pass over the entire persona workspace.",
						"",
						"Use tools to inspect index.md, all people/scenes memory files, and any observations files that help.",
						"",
						"Dream goals:",
						"- Cross-scene linking for the same person.",
						"- Rebuild index.md as a globally consistent snapshot.",
						"- Compress stale low-value memories while preserving core identity and correction details.",
						"- Create missing people files when repeated mentions across scenes justify it.",
						"- You may delete low-value people/scenes files if forgetting them is appropriate, but only after updating index.md so references stay consistent.",
						"- Never invent facts and never modify observations directly.",
						"",
						"Current corpus snapshot:",
						`- index.md present: ${snapshot.indexMarkdown.trim().length > 0 ? "yes" : "no"}`,
						`- people files: ${snapshot.people.length}`,
						`- scene files: ${snapshot.scenes.length}`,
						`- observation files: ${snapshot.observations.length}`,
						"",
						"Call persona_finalize exactly once when you are done. Dream must not consume observations, so finalize with consumeObservationLines=0.",
					].join("\n"),
				});
				this.syncMaintenanceClone(agent.slug, clone.livePersonaDir, clone.tempPersonaDir, result, { allowDeletes: true });
				const updatedSnapshot = this.buildDreamCorpusSnapshot(agent.slug);
				this.store.audit(agent.agentId, "persona.dream_applied", {
					corpusSignature: updatedSnapshot.corpusSignature,
					touchedPaths: result.touchedPaths,
					deletedPaths: result.deletedPaths,
					summary: result.finalize.summary,
				});
				this.writeDreamState(agent.slug, {
					lastAttemptedAt: new Date().toISOString(),
					lastCompletedAt: new Date().toISOString(),
					lastCorpusSignature: updatedSnapshot.corpusSignature,
					lastError: undefined,
				});
			} finally {
				rmSync(clone.tempRoot, { recursive: true, force: true });
			}
			this.clearDreamSkipAudit(agent.agentId);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.writeDreamState(agent.slug, {
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
		this.ensurePersonaLayout(agent.slug);
		if (!this.resolveModel(agent, undefined)) {
			return;
		}
		const observationsDir = this.store.getPersonaObservationsDir(agent.slug);
		const files = existsSync(observationsDir)
			? readdirSync(observationsDir).filter((name) => name.endsWith(".log")).sort()
			: [];
		for (const file of files) {
			const sceneRef = file.replace(/\.log$/i, "");
			const observationPath = join(observationsDir, file);
			const observationLines = this.readObservationLines(observationPath);
			if (observationLines.length === 0) {
				continue;
			}
			if (!shouldRunFormationForObservations(observationLines, Date.now())) {
				continue;
			}
			try {
				const clone = this.createMaintenanceClone(agent.slug);
				try {
					const result = await this.executeMaintenanceSession(agent, undefined, {
						mode: "formation",
						tempPersonaDir: clone.tempPersonaDir,
						maxConsumeObservationLines: observationLines.length,
						allowDeletes: false,
						prompt: [
							`Maintain persona memory for scene ${sceneRef} from backlog observations.`,
							"",
							"Inspect index.md, the scene observation log, and any relevant memory files you need.",
							"Revise existing files with edit, create new people/scenes files with write when necessary, and do not delete files.",
							"Preserve corrections, identity links, uncertainty, and whether the bot was only observing.",
							`Primary observation file: observations/${sceneRef}.log`,
							"When finished, call persona_finalize with how many observation lines were fully incorporated.",
						].join("\n"),
					});
					this.syncMaintenanceClone(agent.slug, clone.livePersonaDir, clone.tempPersonaDir, result, { allowDeletes: false });
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
					rmSync(clone.tempRoot, { recursive: true, force: true });
				}
				this.clearFormationRetryState(agent.slug, sceneRef);
			} catch (error) {
				this.handleFormationFailure(agent, sceneRef, observationPath, observationLines, error);
			}
		}
	}

	private handleFormationFailure(
		agent: AgentSpec,
		sceneRef: string,
		observationPath: string,
		observationLines: string[],
		error: unknown,
	): void {
		const signature = buildObservationSignature(observationLines);
		const previous = this.readFormationRetryState(agent.slug, sceneRef);
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
			this.clearFormationRetryState(agent.slug, sceneRef);
			this.store.audit(agent.agentId, "persona.formation_discarded", {
				sceneRef,
				error: errorMessage,
				attempts,
				discardedObservationLines: observationLines.length,
				observationSignature: signature,
			});
			return;
		}
		writeJsonFile(this.getFormationRetryStatePath(agent.slug, sceneRef), {
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

	private resolveModel(agent: AgentSpec, effectiveModel: WorkerPayload["effectiveModel"] | undefined):
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
		const current = maintenanceLocks.get(agentId) ?? Promise.resolve();
		const next = current
			.catch(() => undefined)
			.then(task)
			.catch((error) => {
				const agent = this.store.getAgentByRef(agentId);
				this.store.audit(agent.agentId, "persona.formation_unhandled_failure", {
					error: error instanceof Error ? error.message : String(error),
				});
			});
		maintenanceLocks.set(agentId, next);
		void next.finally(() => {
			if (maintenanceLocks.get(agentId) === next) {
				maintenanceLocks.delete(agentId);
			}
		});
	}
}
