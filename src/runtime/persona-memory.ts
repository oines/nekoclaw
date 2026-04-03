import { createHash } from "node:crypto";
import { appendFileSync, closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
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
const FORMATION_MIN_OBSERVATION_LINES = 50;
const FORMATION_MAX_WAIT_MS = 30 * 60 * 1_000;
const FORMATION_MAX_RETRIES = 3;
const DREAM_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const MAINTENANCE_TIMEOUT_MS = 120_000;
const MANIFEST_TEXT_MAX_CHARS = 220;
const MANIFEST_SCAN_MAX_FILES = 200;
const MANIFEST_SCAN_MAX_BYTES = 8 * 1024;

const maintenanceLocks = new Map<string, Promise<void>>();
const backlogSweepQueued = new Set<string>();
const dreamQueued = new Set<string>();
const dreamSkipAuditCache = new Map<string, string>();

interface PersonaMemoryManifestEntry {
	path: string;
	kind: "people" | "scene";
	title: string;
	description: string;
	mtimeMs: number;
}

interface ParsedPersonaMemoryFile {
	path: string;
	kind: "people" | "scene";
	title: string;
	description: string;
	bodyContent: string;
	hasFrontmatter: boolean;
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

interface DreamObservationEntry {
	path: string;
	lineCount: number;
	mtimeMs: number;
}

interface DreamCorpusSnapshot {
	indexPresent: boolean;
	indexMtimeMs: number;
	indexSizeBytes: number;
	manifest: PersonaMemoryManifestEntry[];
	observations: DreamObservationEntry[];
	memoryManifestText: string;
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

function collectReplyText(payload: ReplyPayload | undefined): string {
	return payload?.text?.trim() || "";
}

function collectEventText(event: InboundMessageEvent): string {
	return summarizeBlocks(event.blocks).join("\n").trim();
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

function trimManifestText(value: string, maxChars = MANIFEST_TEXT_MAX_CHARS): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxChars) {
		return normalized;
	}
	return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function extractFrontmatterBlock(content: string): { frontmatter: Record<string, string>; body: string; hasFrontmatter: boolean } {
	const normalized = content.replace(/\r\n/g, "\n");
	if (!normalized.startsWith("---\n")) {
		return { frontmatter: {}, body: content, hasFrontmatter: false };
	}
	const lines = normalized.split("\n");
	let closingIndex = -1;
	for (let index = 1; index < lines.length; index += 1) {
		if (lines[index]?.trim() === "---") {
			closingIndex = index;
			break;
		}
	}
	if (closingIndex < 1) {
		return { frontmatter: {}, body: content, hasFrontmatter: false };
	}
	const frontmatter: Record<string, string> = {};
	for (const rawLine of lines.slice(1, closingIndex)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) {
			continue;
		}
		const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!match?.[1]) {
			continue;
		}
		let value = (match[2] ?? "").trim();
		const quoted = value.match(/^(['"])(.*)\1$/);
		if (quoted?.[2] !== undefined) {
			value = quoted[2];
		}
		frontmatter[match[1]] = value;
	}
	return {
		frontmatter,
		body: lines.slice(closingIndex + 1).join("\n").replace(/^\n+/, ""),
		hasFrontmatter: true,
	};
}

function deriveLegacyTitle(relativePath: string, body: string): string {
	for (const rawLine of body.split(/\r?\n/)) {
		const line = rawLine.trim();
		const heading = line.match(/^#{1,6}\s+(.+)$/);
		if (heading?.[1]) {
			return trimManifestText(heading[1], 120);
		}
	}
	return relativePath.split("/").pop()?.replace(/\.md$/i, "") ?? relativePath;
}

function deriveLegacyDescription(body: string): string {
	const lines = body
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.match(/^#{1,6}\s+/));
	if (lines.length === 0) {
		return "";
	}
	const start = lines[0]!.replace(/^[-*]\s+/, "");
	const continuation = lines.slice(1).find((line) => !line.startsWith("- ") && !line.startsWith("* "));
	return trimManifestText([start, continuation].filter(Boolean).join(" "));
}

function parsePersonaMemoryFile(relativePath: string, rawContent: string): ParsedPersonaMemoryFile {
	const { frontmatter, body, hasFrontmatter } = extractFrontmatterBlock(rawContent);
	const bodyContent = body.trim();
	return {
		path: relativePath,
		kind: relativePath.startsWith("memory/people/") ? "people" : "scene",
		title: trimManifestText(frontmatter.title || deriveLegacyTitle(relativePath, bodyContent), 120),
		description: trimManifestText(frontmatter.description || deriveLegacyDescription(bodyContent)),
		bodyContent,
		hasFrontmatter,
	};
}

function escapeFrontmatterValue(value: string): string {
	return JSON.stringify(value);
}

function ensureCanonicalPersonaMemoryContent(relativePath: string, rawContent: string): string {
	const entry = parsePersonaMemoryFile(relativePath, rawContent);
	if (entry.hasFrontmatter) {
		return rawContent;
	}
	const body = entry.bodyContent || rawContent.trim();
	return [
		"---",
		`title: ${escapeFrontmatterValue(entry.title)}`,
		`description: ${escapeFrontmatterValue(entry.description)}`,
		"---",
		"",
		body,
	].join("\n").trimEnd() + "\n";
}

function readFileHeaderWindow(path: string, maxBytes = MANIFEST_SCAN_MAX_BYTES): string {
	const fd = openSync(path, "r");
	try {
		const buffer = Buffer.allocUnsafe(maxBytes);
		const bytesRead = readSync(fd, buffer, 0, maxBytes, 0);
		return buffer.subarray(0, bytesRead).toString("utf-8");
	} finally {
		closeSync(fd);
	}
}

function formatPersonaMemoryManifest(entries: PersonaMemoryManifestEntry[]): string {
	if (entries.length === 0) {
		return "(none)";
	}
	return entries
		.map(
			(entry) =>
				`- [${entry.kind}] ${entry.title || "(untitled)"} | ${entry.path} (${new Date(entry.mtimeMs).toISOString()}): ${entry.description || "(no description)"}`,
		)
		.join("\n");
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

function buildDreamSkipKey(reason: string, details: Record<string, unknown>): string {
	return JSON.stringify({ reason, ...details });
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
	): Promise<PreparedPersonaContext> {
		this.ensurePersonaLayout(agent.slug);
		const sceneRef = buildSceneRef(session, event);
		const indexMarkdown = trimToTokenBudget(
			readTextFile(this.store.getPersonaIndexPath(agent.slug), ""),
			INDEX_TOKEN_BUDGET,
		);
		const sceneObservations = this.readSceneObservations(agent.slug, sceneRef);

		return {
			indexMarkdown,
			sceneObservations,
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
			snapshot.indexSizeBytes === 0 &&
			snapshot.manifest.length === 0 &&
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
			peopleFiles: snapshot.manifest.filter((entry) => entry.kind === "people").length,
			sceneFiles: snapshot.manifest.filter((entry) => entry.kind === "scene").length,
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

	private buildDreamCorpusSnapshot(slug: string): DreamCorpusSnapshot {
		this.ensurePersonaLayout(slug);
		const personaDir = this.store.getPersonaDir(slug);
		const manifest = this.scanPersonaMemoryManifest(slug);
		const observations = listFilesWithExtension(this.store.getPersonaObservationsDir(slug), personaDir, ".log").map((path) =>
			this.readDreamObservationEntry(personaDir, path),
		);
		const indexPath = this.store.getPersonaIndexPath(slug);
		const indexPresent = existsSync(indexPath);
		const indexStats = indexPresent ? statSync(indexPath) : undefined;
		const signatureSeed = [
			`index:index.md:${indexStats?.mtimeMs ?? 0}`,
			...manifest.map((entry) => `memory:${entry.path}:${entry.mtimeMs}`),
			...observations.map((entry) => `observation:${entry.path}:${entry.mtimeMs}:${entry.lineCount}`),
		].join("\n\n");
		return {
			indexPresent,
			indexMtimeMs: indexStats?.mtimeMs ?? 0,
			indexSizeBytes: indexStats?.size ?? 0,
			manifest,
			observations,
			memoryManifestText: formatPersonaMemoryManifest(manifest),
			corpusSignature: createHash("sha256").update(signatureSeed).digest("hex"),
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
			lineCount: lines.length,
			mtimeMs: stats.mtimeMs,
		};
	}

	private scanPersonaMemoryManifest(slug: string): PersonaMemoryManifestEntry[] {
		this.ensurePersonaLayout(slug);
		const personaDir = this.store.getPersonaDir(slug);
		const paths = [
			...listMarkdownFiles(this.store.getPersonaPeopleDir(slug), personaDir),
			...listMarkdownFiles(this.store.getPersonaScenesDir(slug), personaDir),
		];
		return paths
			.map((relativePath) => {
				const absolutePath = safeJoinPersonaPath(personaDir, relativePath);
				const parsed = parsePersonaMemoryFile(relativePath, readFileHeaderWindow(absolutePath));
				const stats = statSync(absolutePath);
				return {
					path: parsed.path,
					kind: parsed.kind,
					title: parsed.title,
					description: parsed.description,
					mtimeMs: stats.mtimeMs,
				} satisfies PersonaMemoryManifestEntry;
			})
			.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path))
			.slice(0, MANIFEST_SCAN_MAX_FILES);
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
			const rawContent = readTextFile(tempPath, "");
			const nextContent = isAllowedMemoryPath(relativePath)
				? ensureCanonicalPersonaMemoryContent(relativePath, rawContent)
				: rawContent;
			writeTextFile(safeJoinPersonaPath(livePersonaDir, relativePath), nextContent);
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
				"People and scene memory files must use YAML frontmatter with title and description, followed by natural-language Markdown body text.",
				"Existing files must be revised with edit. Use write only to create a new memory/people or memory/scenes file that does not exist yet.",
				"Preserve existing frontmatter when it is still correct, revise description when the body meaning changes, and add frontmatter when editing a legacy file without it.",
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
						"- Ensure every people/scenes file you touch has YAML frontmatter with stable title and a concise description for recall.",
						"- Keep every index.md person and scene entry path-bearing so the worker can read the detailed file later.",
						"- Do not delete files.",
						"- Preserve corrections, identity links, uncertainty, and whether you observed or participated.",
						"",
						"Memory files manifest:",
						this.buildDreamCorpusSnapshot(input.agent.slug).memoryManifestText,
						"",
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
			snapshot.indexSizeBytes === 0 &&
			snapshot.manifest.length === 0 &&
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
			peopleFiles: snapshot.manifest.filter((entry) => entry.kind === "people").length,
			sceneFiles: snapshot.manifest.filter((entry) => entry.kind === "scene").length,
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
						"- Keep every person and scene entry in index.md path-bearing so the worker can read detailed files directly.",
						"- Compress stale low-value memories while preserving core identity and correction details.",
						"- Create missing people files when repeated mentions across scenes justify it.",
						"- Ensure every people/scenes file you keep or create has YAML frontmatter with title and a concise description for recall.",
						"- You may delete low-value people/scenes files if forgetting them is appropriate, but only after updating index.md so references stay consistent.",
						"- Never invent facts and never modify observations directly.",
						"",
						"Current corpus snapshot:",
						`- index.md present: ${snapshot.indexSizeBytes > 0 ? "yes" : "no"}`,
						`- people files: ${snapshot.manifest.filter((entry) => entry.kind === "people").length}`,
						`- scene files: ${snapshot.manifest.filter((entry) => entry.kind === "scene").length}`,
						`- observation files: ${snapshot.observations.length}`,
						"",
						"Memory files manifest:",
						snapshot.memoryManifestText,
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
						"Any people/scenes file you touch should end with YAML frontmatter plus natural-language Markdown body.",
						"Keep every index.md person and scene entry path-bearing so the worker can read the detailed file later.",
						"Preserve corrections, identity links, uncertainty, and whether the bot was only observing.",
						`Primary observation file: observations/${sceneRef}.log`,
						"",
						"Memory files manifest:",
						this.buildDreamCorpusSnapshot(agent.slug).memoryManifestText,
						"",
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
