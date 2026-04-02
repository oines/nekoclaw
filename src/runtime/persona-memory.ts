import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { complete, type Context } from "@mariozechner/pi-ai";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
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
const FORMATION_MIN_OBSERVATION_LINES = 50;
const FORMATION_MAX_WAIT_MS = 30 * 60 * 1_000;
const FORMATION_MAX_RETRIES = 3;

const formationLocks = new Map<string, Promise<void>>();
const backlogSweepQueued = new Set<string>();

interface SelectorResult {
	paths: string[];
	notes: string;
}

interface FormationWrite {
	path: string;
	content: string;
}

interface FormationResult {
	indexMarkdown: string;
	writes: FormationWrite[];
	deletes: string[];
	consumeObservationLines: number;
}

interface FormationRetryState {
	signature: string;
	attempts: number;
	updatedAt: string;
	lastError?: string;
}

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

function fallbackFormation(input: {
	sceneRef: string;
	observationLines: string[];
	replyText: string;
	event?: InboundMessageEvent;
	indexMarkdown: string;
}): FormationResult {
	const writes: FormationWrite[] = [];
	const notes: string[] = [];
	if (input.event) {
		const peoplePath = buildAccountMemoryPath(input.event);
		const speakerName = input.event.sender.displayName || `${input.event.channelType}:${input.event.sender.externalId ?? input.event.chatId}`;
		const memoryBody = [
			`${speakerName}`,
			"",
			`最近一次相关互动里，对方说：${collectEventText(input.event)}`,
			input.replyText ? `我当时回复了：${input.replyText}` : undefined,
		]
			.filter(Boolean)
			.join("\n");
		writes.push({ path: peoplePath, content: `${memoryBody}\n` });
		notes.push(`- ${speakerName}：最近一次相关互动已记录 → ${peoplePath}`);
	}
	if (input.observationLines.length > 0) {
		const scenePath = buildSceneMemoryPath(input.sceneRef);
		const sceneBody = [
			`这个场景近期的旁观或互动记录：`,
			"",
			...input.observationLines.slice(-12),
		].join("\n");
		writes.push({ path: scenePath, content: `${sceneBody}\n` });
		notes.push(`- ${input.sceneRef}：近期场景记录 → ${scenePath}`);
	}
	const indexMarkdown = notes.length > 0 ? `## 我认识的人和场景\n${notes.join("\n")}\n` : input.indexMarkdown;
	return {
		indexMarkdown,
		writes,
		deletes: [],
		consumeObservationLines: input.observationLines.length,
	};
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
		const selector = (await this.runSelector(agent, effectiveModel, {
			indexMarkdown,
			sceneObservations,
			currentMessage: collectEventText(event),
			candidatePaths,
			candidateContents,
		})) ?? fallbackSelector(indexMarkdown, sceneObservations, collectEventText(event), candidateContents);

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
		this.enqueueFormation(input.agent.agentId, async () => {
			await this.runFormationForTurn(input);
		});
	}

	queueBacklogSweep(agent: AgentSpec): void {
		if (backlogSweepQueued.has(agent.agentId)) {
			return;
		}
		backlogSweepQueued.add(agent.agentId);
		this.enqueueFormation(agent.agentId, async () => {
			try {
				await this.runBacklogSweep(agent);
			} finally {
				backlogSweepQueued.delete(agent.agentId);
			}
		});
	}

	private ensurePersonaLayout(slug: string): void {
		for (const dir of [
			this.store.getPersonaDir(slug),
			this.store.getPersonaPeopleDir(slug),
			this.store.getPersonaScenesDir(slug),
			this.store.getPersonaObservationsDir(slug),
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

	private async runSelector(
		agent: AgentSpec,
		effectiveModel: WorkerPayload["effectiveModel"] | undefined,
		input: {
			indexMarkdown: string;
			sceneObservations: string;
			currentMessage: string;
			candidatePaths: string[];
			candidateContents: Array<{ path: string; content: string }>;
		},
	): Promise<SelectorResult | undefined> {
		if (input.candidatePaths.length === 0) {
			return {
				paths: [],
				notes: "No detailed memory files available yet.",
			};
		}
		const modelConfig = this.resolveModel(agent, effectiveModel);
		if (!modelConfig) {
			return undefined;
		}
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
			const raw = await extractCompletionText(modelConfig.model, modelConfig.apiKey, context);
			const json = extractJsonObject(raw);
			if (!json) {
				return undefined;
			}
			const parsed = JSON.parse(json) as Partial<SelectorResult>;
			const allowed = new Set(input.candidatePaths);
			const paths = (parsed.paths ?? [])
				.filter((path): path is string => typeof path === "string")
				.filter((path) => allowed.has(path))
				.slice(0, MAX_SELECTED_MEMORY_FILES);
			return {
				paths,
				notes: normalizeText(parsed.notes) || "Selected detailed memories using the model.",
			};
		} catch {
			return undefined;
		}
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
			const currentSceneMemoryPath = buildSceneMemoryPath(sceneRef);
			const currentSceneMemory = readTextFile(
				safeJoinPersonaPath(this.store.getPersonaDir(input.agent.slug), currentSceneMemoryPath),
				"",
			);
			const existingDocs: PreparedPersonaContext["selectedMemories"] = [
				...input.personaContext.selectedMemories,
				...(currentSceneMemory ? [{ path: currentSceneMemoryPath, content: currentSceneMemory }] : []),
			];
			const result =
				(await this.runFormationModel(input.agent, input.effectiveModel, {
					indexMarkdown: input.personaContext.indexMarkdown,
					sceneRef,
					observationLines,
					replyText: input.replyText,
					currentMessage: collectEventText(input.event),
					existingDocs,
				})) ??
				fallbackFormation({
					sceneRef,
					observationLines,
					replyText: input.replyText,
					event: input.event,
					indexMarkdown: input.personaContext.indexMarkdown,
				});
			this.applyFormationResult(input.agent.slug, sceneRef, observationPath, observationLines, result);
			this.clearFormationRetryState(input.agent.slug, sceneRef);
		} catch (error) {
			this.handleFormationFailure(input.agent, sceneRef, observationPath, observationLines, error);
		}
	}

	private async runBacklogSweep(agent: AgentSpec): Promise<void> {
		this.ensurePersonaLayout(agent.slug);
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
				const indexMarkdown = readTextFile(this.store.getPersonaIndexPath(agent.slug), "");
				const result =
					(await this.runFormationModel(agent, undefined, {
						indexMarkdown,
						sceneRef,
						observationLines,
						replyText: "",
						currentMessage: "",
						existingDocs: [],
					})) ??
					fallbackFormation({
						sceneRef,
						observationLines,
						replyText: "",
						indexMarkdown,
					});
				this.applyFormationResult(agent.slug, sceneRef, observationPath, observationLines, result);
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

	private async runFormationModel(
		agent: AgentSpec,
		effectiveModel: WorkerPayload["effectiveModel"] | undefined,
		input: {
			indexMarkdown: string;
			sceneRef: string;
			observationLines: string[];
			replyText: string;
			currentMessage: string;
			existingDocs: PreparedPersonaContext["selectedMemories"];
		},
	): Promise<FormationResult | undefined> {
		const modelConfig = this.resolveModel(agent, effectiveModel);
		if (!modelConfig) {
			return undefined;
		}
		const context: Context = {
			systemPrompt: [
				"你是 Nekoclaw 的后台记忆整理器（formation）。",
				"你维护的记忆内容只有 Markdown 自然语言，不允许把人物记忆拆成结构化字段。",
				"遵循这些原则：索引常驻，正文按需；旁观不能写成参与；不确定不能写成确定；优先保留长期背景、共同经历、关系动态、纠偏和未完事项；删掉琐碎、过期、重复、一次性闲聊。",
				`index.md 目标不超过约 ${INDEX_TOKEN_BUDGET} tokens；单个正文文件目标不超过约 ${MEMORY_FILE_TOKEN_BUDGET} tokens。`,
				"你可以重写 index.md，并新增/改写 memory/people/*.md 或 memory/scenes/*.md。",
				"输出必须是 JSON，格式：",
				"{\"indexMarkdown\":\"...\",\"writes\":[{\"path\":\"memory/people/x.md\",\"content\":\"...\"}],\"deletes\":[\"memory/people/y.md\"],\"consumeObservationLines\":3}",
				"所有 content 都必须是 Markdown 自然语言正文，不要返回 schema 化事实表。",
			].join("\n"),
			messages: [
				{
					role: "user",
					content: [
						`本轮当前消息：\n${input.currentMessage || "(none)"}`,
						`本轮实际回复：\n${input.replyText || "(none)"}`,
						`当前 index.md：\n${input.indexMarkdown || "(empty)"}`,
						`当前 sceneRef：${input.sceneRef}`,
						`当前 scene observation lines：\n${input.observationLines.join("\n")}`,
						`相关已读记忆正文：\n${
							input.existingDocs.length > 0
								? input.existingDocs.map((doc) => `### ${doc.path}\n${doc.content}`).join("\n\n")
								: "(none)"
						}`,
					].join("\n\n"),
					timestamp: Date.now(),
				},
			],
		};
		try {
			const raw = await extractCompletionText(modelConfig.model, modelConfig.apiKey, context);
			const json = extractJsonObject(raw);
			if (!json) {
				return undefined;
			}
			const parsed = JSON.parse(json) as Partial<FormationResult>;
			const writes = (parsed.writes ?? [])
				.filter((entry): entry is FormationWrite => Boolean(entry && typeof entry.path === "string" && typeof entry.content === "string"))
				.filter((entry) => isAllowedMemoryPath(entry.path))
				.map((entry) => ({
					path: entry.path,
					content: `${normalizeText(entry.content)}\n`,
				}));
			const deletes = (parsed.deletes ?? [])
				.filter((value): value is string => typeof value === "string")
				.filter((value) => isAllowedMemoryPath(value));
			const consumeObservationLines = Math.max(
				0,
				Math.min(input.observationLines.length, Math.floor(Number(parsed.consumeObservationLines ?? 0) || 0)),
			);
			return {
				indexMarkdown: normalizeText(parsed.indexMarkdown) || input.indexMarkdown,
				writes,
				deletes,
				consumeObservationLines,
			};
		} catch {
			return undefined;
		}
	}

	private applyFormationResult(
		slug: string,
		sceneRef: string,
		observationPath: string,
		observationLines: string[],
		result: FormationResult,
	): void {
		this.ensurePersonaLayout(slug);
		writeTextFile(this.store.getPersonaIndexPath(slug), `${normalizeText(result.indexMarkdown)}\n`);
		const personaDir = this.store.getPersonaDir(slug);
		for (const write of result.writes) {
			if (!isAllowedMemoryPath(write.path)) {
				continue;
			}
			writeTextFile(safeJoinPersonaPath(personaDir, write.path), `${normalizeText(write.content)}\n`);
		}
		for (const target of result.deletes) {
			if (!isAllowedMemoryPath(target)) {
				continue;
			}
			removeFileIfExists(safeJoinPersonaPath(personaDir, target));
		}
		const consumeCount = Math.max(0, Math.min(observationLines.length, result.consumeObservationLines));
		const remaining = observationLines.slice(consumeCount).join("\n");
		if (remaining.trim().length === 0) {
			rmSync(observationPath, { force: true });
		} else {
			writeTextFile(observationPath, `${remaining}\n`);
		}
		this.store.audit(this.store.getAgentByRef(slug).agentId, "persona.formation_applied", {
			sceneRef,
			writes: result.writes.map((write) => write.path),
			deletes: result.deletes,
			consumedObservationLines: consumeCount,
		});
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

	private enqueueFormation(agentId: string, task: () => Promise<void>): void {
		const current = formationLocks.get(agentId) ?? Promise.resolve();
		const next = current
			.catch(() => undefined)
			.then(task)
			.catch((error) => {
				const agent = this.store.getAgentByRef(agentId);
				this.store.audit(agent.agentId, "persona.formation_unhandled_failure", {
					error: error instanceof Error ? error.message : String(error),
				});
			});
		formationLocks.set(agentId, next);
		void next.finally(() => {
			if (formationLocks.get(agentId) === next) {
				formationLocks.delete(agentId);
			}
		});
	}
}
