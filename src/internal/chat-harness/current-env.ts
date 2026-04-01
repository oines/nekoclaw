import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createNapcatChannelPlugin } from "../../channels/napcat.js";
import { createTelegramChannelPlugin } from "../../channels/telegram.js";
import { NEKOCLAW_CONTAINER_WORKSPACE_DIR } from "../../config.js";
import { ensureAgentContainer, removeAgentContainer } from "../../runtime/docker.js";
import { JobQueueService } from "../../runtime/job-queue.js";
import { MessageRouterService } from "../../runtime/message-router.js";
import { OutboundDispatchService } from "../../runtime/outbound-dispatch.js";
import { CommandRouterService } from "../../runtime/command-router.js";
import { WorkerRunnerService } from "../../runtime/worker-runner.js";
import { getRuntimeKey } from "../../runtime/runtime-key.js";
import { JsonNekoclawStore } from "../../store/json-store.js";
import type {
	AgentSpec,
	AuditEntry,
	ChannelPlugin,
	ChannelType,
	PairRequest,
	QueueEvent,
	ReplyPayload,
	RunJob,
	SessionRecord,
	WorkerResult,
} from "../../types.js";
import { FakeNapcatClient, FakeTelegramBot, type HarnessTranscriptEntry, createTelegramMessage } from "./fake-transports.js";

export type HarnessChannel = "telegram" | "napcat" | "both";

export interface InternalChatHarnessRunOptions {
	agentRef: string;
	channel?: HarnessChannel;
	scenario?: string | string[];
	keepSandbox?: boolean;
	verbose?: boolean;
	timeoutMs?: number;
	executeJob?: (job: RunJob, context: CurrentEnvHarnessContext) => Promise<WorkerResult>;
}

export interface InternalChatHarnessEvidence {
	transcript: HarnessTranscriptEntry[];
	pairs: PairRequest[];
	queueTail: QueueEvent[];
	auditTail: AuditEntry[];
	sessionLogTail: unknown[];
	lastError?: string;
	sandboxAgentSlug: string;
}

export interface InternalChatHarnessScenarioResult {
	name: string;
	channel: Exclude<HarnessChannel, "both">;
	status: "passed" | "failed" | "skipped";
	durationMs: number;
	error?: string;
	outboundPreview?: string;
	evidence: InternalChatHarnessEvidence;
}

export interface InternalChatHarnessReport {
	ok: boolean;
	agentRef: string;
	agentSlug: string;
	startedAt: string;
	finishedAt: string;
	results: InternalChatHarnessScenarioResult[];
}

interface HarnessDriver {
	readonly channel: Exclude<HarnessChannel, "both">;
	readonly plugin: ChannelPlugin;
	getTranscript(): HarnessTranscriptEntry[];
	clearTranscript(): void;
	sendMessage(input: {
		chatKind: "dm" | "group";
		chatId?: string;
		senderId: string;
		senderName: string;
		text: string;
		replyToMessageId?: string;
		mentionBot?: boolean;
		attachments?: Array<{
			kind: "image" | "file";
			name?: string;
			mimeType?: string;
			bytes: Uint8Array;
		}>;
		attachment?: {
			kind: "image" | "file";
			name?: string;
			mimeType?: string;
			bytes: Uint8Array;
		};
	}): Promise<{ chatId: string; messageId: string }>;
	botUserId(): string;
	botUsername(): string | undefined;
}

export interface CurrentEnvHarnessContext {
	store: JsonNekoclawStore;
	agent: AgentSpec;
	outboundDispatch: OutboundDispatchService;
	jobQueue: JobQueueService;
	plugins: Map<string, ChannelPlugin>;
	drivers: Map<Exclude<HarnessChannel, "both">, HarnessDriver>;
	timeoutMs: number;
	workspaceRoot: string;
	createWorkspaceFixture(input: { relativePath: string; bytes: Uint8Array }): {
		relativePath: string;
		hostPath: string;
		containerPath: string;
	};
	_restoreFetchRegistry?: () => void;
}

interface ScenarioContext extends CurrentEnvHarnessContext {
	driver: HarnessDriver;
	channel: Exclude<HarnessChannel, "both">;
	dmChatId: string;
	groupChatId: string;
	dmUserId: string;
	groupUserId: string;
	adminUserId: string;
}

interface ScenarioDefinition {
	name: string;
	channel: Exclude<HarnessChannel, "both">;
	run(context: ScenarioContext): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const GROUP_TITLE = "Harness Group";
const RED_PNG_BYTES = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mP8z8BQDwAFgwJ/lcezWQAAAABJRU5ErkJggg==",
	"base64",
);
const BLUE_PNG_BYTES = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mNk+M/wHwAEAQH/cetH5QAAAABJRU5ErkJggg==",
	"base64",
);
const FILE_SECRET = "HARNESS_FILE_SECRET_731";
const FILE_SECRET_EXTRA = "HARNESS_FILE_SECRET_992";
const FILE_SECRET_BYTES = Buffer.from(`${FILE_SECRET}\n`, "utf-8");
const FILE_SECRET_EXTRA_BYTES = Buffer.from(`${FILE_SECRET_EXTRA}\n`, "utf-8");

function nowIso(): string {
	return new Date().toISOString();
}

function assertCondition(condition: unknown, message: string): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickScenarioNames(option: string | string[] | undefined, definitions: ScenarioDefinition[]): Set<string> | undefined {
	if (!option) {
		return undefined;
	}
	const names = Array.isArray(option) ? option : option.split(",").map((value) => value.trim()).filter(Boolean);
	return new Set(names);
}

function tail<T>(values: T[], count = 20): T[] {
	return values.slice(Math.max(0, values.length - count));
}

function installFetchRegistry(): {
	register(url: string, bytes: Uint8Array): void;
	restore(): void;
} {
	const binaries = new Map<string, Uint8Array>();
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.toString()
					: typeof input === "object" && input !== null && "url" in input
						? String((input as { url: unknown }).url)
						: String(input);
		const bytes = binaries.get(url);
		if (bytes) {
			const view = bytes.slice();
			return {
				ok: true,
				status: 200,
				arrayBuffer: async () =>
					view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength),
			} as Response;
		}
		if (originalFetch) {
			return originalFetch(input as never, init);
		}
		throw new Error(`No harness media registered for ${url}`);
	}) as typeof fetch;
	return {
		register(url, bytes) {
			binaries.set(url, bytes);
		},
		restore() {
			if (originalFetch) {
				globalThis.fetch = originalFetch;
				return;
			}
			delete (globalThis as { fetch?: typeof fetch }).fetch;
		},
	};
}

function readSessionLogTail(store: JsonNekoclawStore, agent: AgentSpec, count = 20): unknown[] {
	const sessions = store.listSessions(agent.agentId);
	if (sessions.length === 0) {
		return [];
	}
	const latest = sessions[sessions.length - 1];
	const path = store.getSessionLogPath(agent.slug, latest.sessionRecordId);
	if (!existsSync(path)) {
		return [];
	}
	return tail(
		readFileSync(path, "utf-8")
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => {
				try {
					return JSON.parse(line) as unknown;
				} catch {
					return line;
				}
			}),
		count,
	);
}

async function waitForQueueIdle(context: CurrentEnvHarnessContext): Promise<void> {
	const deadline = Date.now() + context.timeoutMs;
	while (Date.now() < deadline) {
		const status = context.jobQueue.getStatus(context.agent.agentId);
		if (!status.processing && status.queued === 0) {
			await sleep(25);
			const next = context.jobQueue.getStatus(context.agent.agentId);
			if (!next.processing && next.queued === 0) {
				return;
			}
		}
		await sleep(50);
	}
	throw new Error(`Timed out waiting for queue idle after ${context.timeoutMs}ms`);
}

function getPendingPair(store: JsonNekoclawStore, agentId: string, channel: ChannelType, chatId: string): PairRequest | undefined {
	return store
		.listPairRequests(agentId)
		.find((pair) => pair.channelType === channel && pair.externalConversationId === chatId && pair.status === "pending");
}

async function acceptPendingPair(context: ScenarioContext, chatId: string): Promise<SessionRecord> {
	const pair = getPendingPair(context.store, context.agent.agentId, context.channel, chatId);
	assertCondition(pair, `Expected a pending ${context.channel} pair for chat ${chatId}`);
	const accepted = context.store.acceptPair(pair.code);
	await context.outboundDispatch.sendPairAcceptedMessage(accepted.pair);
	return accepted.session;
}

function latestOutbound(driver: HarnessDriver, chatId: string): HarnessTranscriptEntry | undefined {
	return [...driver.getTranscript()].reverse().find((entry) => entry.kind === "outbound" && entry.chatId === chatId);
}

function countOutbound(driver: HarnessDriver, chatId: string): number {
	return driver.getTranscript().filter((entry) => entry.kind === "outbound" && entry.chatId === chatId).length;
}

function latestSession(store: JsonNekoclawStore, agentId: string, chatId: string): SessionRecord | undefined {
	return [...store.listSessions(agentId)].reverse().find((session) => session.externalConversationId === chatId);
}

async function sendAndWait(
	context: ScenarioContext,
	input: Parameters<HarnessDriver["sendMessage"]>[0],
): Promise<{ chatId: string; messageId: string }> {
	const sent = await context.driver.sendMessage(input);
	await waitForQueueIdle(context);
	return sent;
}

async function expectOutboundContains(
	context: ScenarioContext,
	chatId: string,
	matcher: string | RegExp,
): Promise<HarnessTranscriptEntry> {
	await waitForQueueIdle(context);
	const outbound = latestOutbound(context.driver, chatId);
	assertCondition(outbound, `Expected outbound message for chat ${chatId}`);
	const text = outbound.text ?? "";
	if (typeof matcher === "string") {
		assertCondition(text.includes(matcher), `Expected outbound to contain "${matcher}", got "${text}"`);
	} else {
		assertCondition(matcher.test(text), `Expected outbound to match ${matcher}, got "${text}"`);
	}
	return outbound;
}

async function expectAnyOutboundContains(
	context: ScenarioContext,
	chatId: string,
	matcher: string | RegExp,
): Promise<HarnessTranscriptEntry> {
	await waitForQueueIdle(context);
	const outbound = context.driver
		.getTranscript()
		.filter((entry) => entry.kind === "outbound" && entry.chatId === chatId)
		.find((entry) => {
			const text = entry.text ?? "";
			return typeof matcher === "string" ? text.includes(matcher) : matcher.test(text);
		});
	assertCondition(outbound, `Expected some outbound for chat ${chatId} to match ${String(matcher)}`);
	return outbound;
}

async function expectLatestOutboundContainsAll(
	context: ScenarioContext,
	chatId: string,
	matchers: Array<string | RegExp>,
): Promise<HarnessTranscriptEntry> {
	await waitForQueueIdle(context);
	const outbound = latestOutbound(context.driver, chatId);
	assertCondition(outbound, `Expected outbound message for chat ${chatId}`);
	const text = outbound.text ?? "";
	for (const matcher of matchers) {
		if (typeof matcher === "string") {
			assertCondition(text.includes(matcher), `Expected outbound to contain "${matcher}", got "${text}"`);
			continue;
		}
		assertCondition(matcher.test(text), `Expected outbound to match ${matcher}, got "${text}"`);
	}
	return outbound;
}

async function expectNoOutboundDelta(context: ScenarioContext, chatId: string, previousCount: number): Promise<void> {
	await waitForQueueIdle(context);
	const currentCount = countOutbound(context.driver, chatId);
	assertCondition(currentCount === previousCount, `Expected no new outbound for chat ${chatId}, got ${currentCount - previousCount}`);
}

function knownModelRef(store: JsonNekoclawStore, agent: AgentSpec): string {
	assertCondition(agent.provider && agent.modelId, `Agent ${agent.slug} has no configured model`);
	return `${agent.provider}/${agent.modelId}`;
}

function listSessionAttachmentNames(context: ScenarioContext, sessionRecordId: string): string[] {
	const dir = context.store.getSessionAttachmentsDir(context.agent.slug, sessionRecordId);
	if (!existsSync(dir)) {
		return [];
	}
	return readdirSync(dir);
}

function presetGroupTrigger(context: ScenarioContext, mode: "all" | "mention"): void {
	context.store.setChannelGroupTrigger(context.agent.agentId, context.channel, mode);
	(context.driver.plugin as { groupTrigger?: "all" | "mention" }).groupTrigger = mode;
}

async function scenarioDmPairPrompt(context: ScenarioContext): Promise<void> {
	await sendAndWait(context, {
		chatKind: "dm",
		chatId: context.dmUserId,
		senderId: context.dmUserId,
		senderName: "Harness DM",
		text: "hello there",
	});
	await expectOutboundContains(context, context.dmUserId, "This chat is not paired yet.");
}

async function scenarioDmPairAcceptAndChat(context: ScenarioContext): Promise<void> {
	await sendAndWait(context, {
		chatKind: "dm",
		chatId: context.dmUserId,
		senderId: context.dmUserId,
		senderName: "Harness DM",
		text: "please pair me",
	});
	await acceptPendingPair(context, context.dmUserId);
	await sendAndWait(context, {
		chatKind: "dm",
		chatId: context.dmUserId,
		senderId: context.dmUserId,
		senderName: "Harness DM",
		text: "Reply with exactly: HARNESS_OK",
	});
	const outbound = latestOutbound(context.driver, context.dmUserId);
	assertCondition(outbound?.text?.trim(), "Expected a non-empty outbound after DM chat");
}

async function scenarioDmContextContinuity(context: ScenarioContext): Promise<void> {
	await sendAndWait(context, {
		chatKind: "dm",
		chatId: context.dmUserId,
		senderId: context.dmUserId,
		senderName: "Harness DM",
		text: "pair me",
	});
	await acceptPendingPair(context, context.dmUserId);
	await sendAndWait(context, {
		chatKind: "dm",
		chatId: context.dmUserId,
		senderId: context.dmUserId,
		senderName: "Harness DM",
		text: "Remember this codeword for later: NEKO-ALPHA-742. Reply with exactly: remembered NEKO-ALPHA-742",
	});
	await sendAndWait(context, {
		chatKind: "dm",
		chatId: context.dmUserId,
		senderId: context.dmUserId,
		senderName: "Harness DM",
		text: "What codeword did I ask you to remember? Reply with the codeword only.",
	});
	await expectOutboundContains(context, context.dmUserId, "NEKO-ALPHA-742");
}

async function scenarioGroupMentionIgnored(context: ScenarioContext): Promise<void> {
	presetGroupTrigger(context, "mention");
	await sendAndWait(context, {
		chatKind: "group",
		chatId: context.groupChatId,
		senderId: context.groupUserId,
		senderName: "Group User",
		text: "/pair",
		mentionBot: true,
	});
	await acceptPendingPair(context, context.groupChatId);
	const before = countOutbound(context.driver, context.groupChatId);
	await sendAndWait(context, {
		chatKind: "group",
		chatId: context.groupChatId,
		senderId: context.groupUserId,
		senderName: "Group User",
		text: "plain group message without mention",
	});
	await expectNoOutboundDelta(context, context.groupChatId, before);
}

async function scenarioGroupMentionChat(context: ScenarioContext): Promise<void> {
	presetGroupTrigger(context, "mention");
	await sendAndWait(context, {
		chatKind: "group",
		chatId: context.groupChatId,
		senderId: context.groupUserId,
		senderName: "Group User",
		text: "/pair",
		mentionBot: true,
	});
	await acceptPendingPair(context, context.groupChatId);
	await sendAndWait(context, {
		chatKind: "group",
		chatId: context.groupChatId,
		senderId: context.groupUserId,
		senderName: "Group User",
		text: "say HARNESS_GROUP_OK",
		mentionBot: true,
	});
	const outbound = latestOutbound(context.driver, context.groupChatId);
	assertCondition(outbound?.text?.trim(), "Expected outbound after mention-addressed group message");
}

async function scenarioGroupReplyChat(context: ScenarioContext): Promise<void> {
	presetGroupTrigger(context, "mention");
	await sendAndWait(context, {
		chatKind: "group",
		chatId: context.groupChatId,
		senderId: context.groupUserId,
		senderName: "Group User",
		text: "/pair",
		mentionBot: true,
	});
	await acceptPendingPair(context, context.groupChatId);
	await sendAndWait(context, {
		chatKind: "group",
		chatId: context.groupChatId,
		senderId: context.groupUserId,
		senderName: "Group User",
		text: "prime the thread",
		mentionBot: true,
	});
	const firstOutbound = latestOutbound(context.driver, context.groupChatId);
	assertCondition(firstOutbound?.messageId, "Expected a first outbound group reply");
	await sendAndWait(context, {
		chatKind: "group",
		chatId: context.groupChatId,
		senderId: context.groupUserId,
		senderName: "Group User",
		text: "reply path should work",
		replyToMessageId: firstOutbound.messageId,
	});
	const outbound = latestOutbound(context.driver, context.groupChatId);
	assertCondition(outbound?.text?.trim(), "Expected outbound after reply-addressed group message");
}

async function scenarioGroupPairCommand(context: ScenarioContext): Promise<void> {
	presetGroupTrigger(context, "all");
	await sendAndWait(context, {
		chatKind: "group",
		chatId: context.groupChatId,
		senderId: context.groupUserId,
		senderName: "Group User",
		text: "/pair",
	});
	await expectOutboundContains(context, context.groupChatId, "This chat is not paired yet.");
	await acceptPendingPair(context, context.groupChatId);
	await sendAndWait(context, {
		chatKind: "group",
		chatId: context.groupChatId,
		senderId: context.groupUserId,
		senderName: "Group User",
		text: "Say paired",
		mentionBot: true,
	});
	const outbound = latestOutbound(context.driver, context.groupChatId);
	assertCondition(outbound?.text?.trim(), "Expected outbound after pairing a group chat");
}

async function scenarioAdminStatus(context: ScenarioContext): Promise<void> {
	presetGroupTrigger(context, "all");
	context.store.addAdmin(context.agent.agentId, {
		channelType: context.channel,
		externalUserId: context.adminUserId,
		displayName: "Harness Admin",
	});
	await sendAndWait(context, {
		chatKind: "group",
		chatId: context.groupChatId,
		senderId: context.adminUserId,
		senderName: "Harness Admin",
		text: "/status",
		mentionBot: context.channel === "telegram",
	});
	await expectOutboundContains(context, context.groupChatId, /Effective model:/);
}

async function scenarioAdminTriggerToggle(context: ScenarioContext): Promise<void> {
	context.store.addAdmin(context.agent.agentId, {
		channelType: context.channel,
		externalUserId: context.adminUserId,
		displayName: "Harness Admin",
	});
	presetGroupTrigger(context, "mention");
	await sendAndWait(context, {
		chatKind: "group",
		chatId: context.groupChatId,
		senderId: context.groupUserId,
		senderName: "Group User",
		text: "/pair",
		mentionBot: true,
	});
	await acceptPendingPair(context, context.groupChatId);
	await sendAndWait(context, {
		chatKind: "group",
		chatId: context.groupChatId,
		senderId: context.adminUserId,
		senderName: "Harness Admin",
		text: "/trigger all",
		mentionBot: true,
	});
	await expectAnyOutboundContains(context, context.groupChatId, "updated to all");
	const before = countOutbound(context.driver, context.groupChatId);
	await sendAndWait(context, {
		chatKind: "group",
		chatId: context.groupChatId,
		senderId: context.groupUserId,
		senderName: "Group User",
		text: "this should now route without mention",
	});
	assertCondition(countOutbound(context.driver, context.groupChatId) > before, "Expected group trigger all to allow a plain message");
}

async function scenarioAdminReset(context: ScenarioContext): Promise<void> {
	context.store.addAdmin(context.agent.agentId, {
		channelType: context.channel,
		externalUserId: context.adminUserId,
		displayName: "Harness Admin",
	});
	await sendAndWait(context, {
		chatKind: "dm",
		chatId: context.adminUserId,
		senderId: context.adminUserId,
		senderName: "Harness Admin",
		text: "pair me",
	});
	const session = await acceptPendingPair(context, context.adminUserId);
	await sendAndWait(context, {
		chatKind: "dm",
		chatId: context.adminUserId,
		senderId: context.adminUserId,
		senderName: "Harness Admin",
		text: "Remember this codeword: RESET-ME-188",
	});
	await sendAndWait(context, {
		chatKind: "dm",
		chatId: context.adminUserId,
		senderId: context.adminUserId,
		senderName: "Harness Admin",
		text: "/reset",
	});
	await expectOutboundContains(context, context.adminUserId, "Session reset.");
	const contextPath = context.store.getSessionContextPath(context.agent.slug, session.sessionRecordId);
	assertCondition(readFileSync(contextPath, "utf-8").trim() === "", "Expected /reset to clear the session context file");
	const latest = context.store.getSession(context.agent.agentId, session.sessionRecordId);
	assertCondition(!latest.modelOverride, "Expected /reset to clear the session model override");
}

async function scenarioAdminModelSessionOverride(context: ScenarioContext): Promise<void> {
	context.store.addAdmin(context.agent.agentId, {
		channelType: context.channel,
		externalUserId: context.adminUserId,
		displayName: "Harness Admin",
	});
	await sendAndWait(context, {
		chatKind: "dm",
		chatId: context.adminUserId,
		senderId: context.adminUserId,
		senderName: "Harness Admin",
		text: "pair me",
	});
	const session = await acceptPendingPair(context, context.adminUserId);
	const modelRef = knownModelRef(context.store, context.agent);
	await sendAndWait(context, {
		chatKind: "dm",
		chatId: context.adminUserId,
		senderId: context.adminUserId,
		senderName: "Harness Admin",
		text: `/model ${modelRef}`,
	});
	const updated = context.store.getSession(context.agent.agentId, session.sessionRecordId);
	assertCondition(updated.modelOverride, "Expected /model to set a session model override");
	await sendAndWait(context, {
		chatKind: "dm",
		chatId: context.adminUserId,
		senderId: context.adminUserId,
		senderName: "Harness Admin",
		text: "/status",
	});
	await expectOutboundContains(context, context.adminUserId, "(session override)");
}

async function scenarioDmImageVision(context: ScenarioContext): Promise<void> {
	await sendAndWait(context, {
		chatKind: "dm",
		chatId: context.dmUserId,
		senderId: context.dmUserId,
		senderName: "Harness DM",
		text: "pair me",
	});
	const session = await acceptPendingPair(context, context.dmUserId);
	await sendAndWait(context, {
		chatKind: "dm",
		chatId: context.dmUserId,
		senderId: context.dmUserId,
		senderName: "Harness DM",
		text: "Look at this image and reply with exactly: RED",
		attachment: {
			kind: "image",
			name: "red-square.png",
			mimeType: "image/png",
			bytes: RED_PNG_BYTES,
		},
	});
	assertCondition(
		listSessionAttachmentNames(context, session.sessionRecordId).length > 0,
		"Expected the inbound image to be persisted into the session attachments directory",
	);
	await expectOutboundContains(context, context.dmUserId, /RED/i);
}

async function scenarioDmMultiImageVision(context: ScenarioContext): Promise<void> {
	await sendAndWait(context, {
		chatKind: "dm",
		chatId: context.dmUserId,
		senderId: context.dmUserId,
		senderName: "Harness DM",
		text: "pair me",
	});
	const session = await acceptPendingPair(context, context.dmUserId);
	await sendAndWait(context, {
		chatKind: "dm",
		chatId: context.dmUserId,
		senderId: context.dmUserId,
		senderName: "Harness DM",
		text: "You received two images in one message. Reply with exactly: RED,BLUE",
		attachments: [
			{
				kind: "image",
				name: "red-square.png",
				mimeType: "image/png",
				bytes: RED_PNG_BYTES,
			},
			{
				kind: "image",
				name: "blue-square.png",
				mimeType: "image/png",
				bytes: BLUE_PNG_BYTES,
			},
		],
	});
	assertCondition(
		listSessionAttachmentNames(context, session.sessionRecordId).filter((name) => /\.(png|jpg|jpeg)$/i.test(name)).length >= 2,
		"Expected both inbound images to be persisted into the session attachments directory",
	);
	await expectLatestOutboundContainsAll(context, context.dmUserId, [/RED/i, /BLUE/i]);
}

async function scenarioDmFileAttachment(context: ScenarioContext): Promise<void> {
	await sendAndWait(context, {
		chatKind: "dm",
		chatId: context.dmUserId,
		senderId: context.dmUserId,
		senderName: "Harness DM",
		text: "pair me",
	});
	const session = await acceptPendingPair(context, context.dmUserId);
	await sendAndWait(context, {
		chatKind: "dm",
		chatId: context.dmUserId,
		senderId: context.dmUserId,
		senderName: "Harness DM",
		text: "Open the attached file and reply with the secret word only.",
		attachment: {
			kind: "file",
			name: "note.txt",
			mimeType: "text/plain",
			bytes: FILE_SECRET_BYTES,
		},
	});
	assertCondition(
		listSessionAttachmentNames(context, session.sessionRecordId).some((name) => name.endsWith(".txt")),
		"Expected the inbound file to be persisted into the session attachments directory",
	);
	await expectAnyOutboundContains(context, context.dmUserId, FILE_SECRET);
}

async function scenarioDmMultiFileAttachment(context: ScenarioContext): Promise<void> {
	await sendAndWait(context, {
		chatKind: "dm",
		chatId: context.dmUserId,
		senderId: context.dmUserId,
		senderName: "Harness DM",
		text: "pair me",
	});
	const session = await acceptPendingPair(context, context.dmUserId);
	await sendAndWait(context, {
		chatKind: "dm",
		chatId: context.dmUserId,
		senderId: context.dmUserId,
		senderName: "Harness DM",
		text: "Open both attached files and reply with both secrets in order separated by a comma only.",
		attachments: [
			{
				kind: "file",
				name: "note-a.txt",
				mimeType: "text/plain",
				bytes: FILE_SECRET_BYTES,
			},
			{
				kind: "file",
				name: "note-b.txt",
				mimeType: "text/plain",
				bytes: FILE_SECRET_EXTRA_BYTES,
			},
		],
	});
	assertCondition(
		listSessionAttachmentNames(context, session.sessionRecordId).filter((name) => name.endsWith(".txt")).length >= 2,
		"Expected both inbound files to be persisted into the session attachments directory",
	);
	await expectLatestOutboundContainsAll(context, context.dmUserId, [FILE_SECRET, FILE_SECRET_EXTRA]);
}

const SCENARIOS: ScenarioDefinition[] = [
	{ name: "dm_pair_prompt", channel: "telegram", run: scenarioDmPairPrompt },
	{ name: "dm_pair_accept_and_chat", channel: "telegram", run: scenarioDmPairAcceptAndChat },
	{ name: "dm_context_continuity", channel: "telegram", run: scenarioDmContextContinuity },
	{ name: "dm_image_vision", channel: "telegram", run: scenarioDmImageVision },
	{ name: "dm_multi_image_vision", channel: "telegram", run: scenarioDmMultiImageVision },
	{ name: "dm_file_attachment", channel: "telegram", run: scenarioDmFileAttachment },
	{ name: "dm_multi_file_attachment", channel: "telegram", run: scenarioDmMultiFileAttachment },
	{ name: "group_mention_ignored", channel: "telegram", run: scenarioGroupMentionIgnored },
	{ name: "group_mention_chat", channel: "telegram", run: scenarioGroupMentionChat },
	{ name: "group_reply_chat", channel: "telegram", run: scenarioGroupReplyChat },
	{ name: "group_pair_command", channel: "telegram", run: scenarioGroupPairCommand },
	{ name: "admin_status", channel: "telegram", run: scenarioAdminStatus },
	{ name: "admin_trigger_toggle", channel: "telegram", run: scenarioAdminTriggerToggle },
	{ name: "admin_reset", channel: "telegram", run: scenarioAdminReset },
	{ name: "admin_model_session_override", channel: "telegram", run: scenarioAdminModelSessionOverride },
	{ name: "dm_pair_prompt", channel: "napcat", run: scenarioDmPairPrompt },
	{ name: "dm_pair_accept_and_chat", channel: "napcat", run: scenarioDmPairAcceptAndChat },
	{ name: "dm_context_continuity", channel: "napcat", run: scenarioDmContextContinuity },
	{ name: "dm_image_vision", channel: "napcat", run: scenarioDmImageVision },
	{ name: "dm_multi_image_vision", channel: "napcat", run: scenarioDmMultiImageVision },
	{ name: "dm_file_attachment", channel: "napcat", run: scenarioDmFileAttachment },
	{ name: "dm_multi_file_attachment", channel: "napcat", run: scenarioDmMultiFileAttachment },
	{ name: "group_mention_ignored", channel: "napcat", run: scenarioGroupMentionIgnored },
	{ name: "group_mention_chat", channel: "napcat", run: scenarioGroupMentionChat },
	{ name: "group_reply_chat", channel: "napcat", run: scenarioGroupReplyChat },
	{ name: "group_pair_command", channel: "napcat", run: scenarioGroupPairCommand },
	{ name: "admin_status", channel: "napcat", run: scenarioAdminStatus },
	{ name: "admin_trigger_toggle", channel: "napcat", run: scenarioAdminTriggerToggle },
	{ name: "admin_reset", channel: "napcat", run: scenarioAdminReset },
	{ name: "admin_model_session_override", channel: "napcat", run: scenarioAdminModelSessionOverride },
];

class TelegramHarnessDriver implements HarnessDriver {
	readonly channel = "telegram" as const;
	readonly bot = new FakeTelegramBot({ id: 9001, username: "mock_bot" });
	readonly plugin: ChannelPlugin;

	private messageCounter = 1;

	constructor(
		private readonly store: JsonNekoclawStore,
		private readonly agent: AgentSpec,
		private readonly registerRemoteBinary: (url: string, bytes: Uint8Array) => void,
	) {
		const channel = this.store.createChannel(agent.agentId, "telegram");
		this.store.setChannelToken(agent.agentId, "telegram", "harness-token");
		this.plugin = createTelegramChannelPlugin(channel, "harness-token", undefined, undefined, { bot: this.bot });
	}

	getTranscript(): HarnessTranscriptEntry[] {
		return this.bot.transcript;
	}

	clearTranscript(): void {
		this.bot.transcript.splice(0, this.bot.transcript.length);
	}

	async sendMessage(input: {
		chatKind: "dm" | "group";
		chatId?: string;
		senderId: string;
		senderName: string;
		text: string;
		replyToMessageId?: string;
		mentionBot?: boolean;
		attachments?: Array<{
			kind: "image" | "file";
			name?: string;
			mimeType?: string;
			bytes: Uint8Array;
		}>;
		attachment?: {
			kind: "image" | "file";
			name?: string;
			mimeType?: string;
			bytes: Uint8Array;
		};
	}): Promise<{ chatId: string; messageId: string }> {
		const chatId = input.chatId ?? (input.chatKind === "dm" ? input.senderId : "-100123");
		const authoredText =
			input.chatKind === "group" && input.mentionBot
				? `@${this.botUsername() ?? "mock_bot"} ${input.text}`
				: input.text;
		const attachments = input.attachments ?? (input.attachment ? [input.attachment] : []);
		const firstMessageId = String(this.messageCounter);
		const mediaGroupId = attachments.length > 1 ? `tg-media-group-${randomUUID()}` : undefined;
		if (attachments.length === 0) {
			const messageId = String(this.messageCounter++);
			await this.bot.emitInbound(
				createTelegramMessage({
					chatId: Number(chatId),
					chatType: input.chatKind === "dm" ? "private" : "supergroup",
					chatTitle: input.chatKind === "group" ? GROUP_TITLE : undefined,
					messageId: Number(messageId),
					replyToMessageId: input.replyToMessageId ? Number(input.replyToMessageId) : undefined,
					text: authoredText,
					from: {
						id: Number(input.senderId),
						first_name: input.senderName,
						username: input.senderName.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
					},
				}),
			);
			return { chatId, messageId };
		}
		for (const [index, attachment] of attachments.entries()) {
			const messageId = String(this.messageCounter++);
			const remoteId = `tg-${attachment.kind}-${randomUUID()}`;
			const remotePath = `${attachment.kind === "image" ? "photos" : "documents"}/${attachment.name ?? `${remoteId}.${attachment.kind === "image" ? "jpg" : "bin"}`}`;
			this.bot.registerFile(remoteId, { file_path: remotePath });
			this.registerRemoteBinary(`https://api.telegram.org/file/botharness-token/${remotePath}`, attachment.bytes);
			await this.bot.emitInbound(
				createTelegramMessage({
					chatId: Number(chatId),
					chatType: input.chatKind === "dm" ? "private" : "supergroup",
					chatTitle: input.chatKind === "group" ? GROUP_TITLE : undefined,
					messageId: Number(messageId),
					mediaGroupId,
					replyToMessageId: input.replyToMessageId ? Number(input.replyToMessageId) : undefined,
					caption: index === 0 ? authoredText : undefined,
					photo:
						attachment.kind === "image"
							? [{ file_id: remoteId, file_size: attachment.bytes.byteLength }]
							: undefined,
					document:
						attachment.kind === "file"
							? {
									file_id: remoteId,
									file_name: attachment.name,
									mime_type: attachment.mimeType,
									file_size: attachment.bytes.byteLength,
								}
							: undefined,
					from: {
						id: Number(input.senderId),
						first_name: input.senderName,
						username: input.senderName.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
					},
				}),
			);
		}
		if (attachments.length > 1) {
			await sleep(125);
		}
		return { chatId, messageId: firstMessageId };
	}

	botUserId(): string {
		return "9001";
	}

	botUsername(): string | undefined {
		return "mock_bot";
	}
}

class NapcatHarnessDriver implements HarnessDriver {
	readonly channel = "napcat" as const;
	readonly client = new FakeNapcatClient();
	readonly plugin: ChannelPlugin;

	private messageCounter = 1;
	private readonly selfId = "9002";

	constructor(
		private readonly store: JsonNekoclawStore,
		private readonly agent: AgentSpec,
		private readonly registerRemoteBinary: (url: string, bytes: Uint8Array) => void,
	) {
		const channel = this.store.createChannel(agent.agentId, "napcat");
		this.store.setChannelToken(agent.agentId, "napcat", "harness-token");
		this.store.setNapcatEndpoint(agent.agentId, {
			wsUrl: "ws://127.0.0.1:6700",
			selfId: this.selfId,
		});
		this.plugin = createNapcatChannelPlugin(
			channel,
			{
				wsUrl: "ws://127.0.0.1:6700",
				selfId: this.selfId,
			},
			undefined,
			undefined,
			{ client: this.client },
		);
	}

	getTranscript(): HarnessTranscriptEntry[] {
		return this.client.transcript;
	}

	clearTranscript(): void {
		this.client.transcript.splice(0, this.client.transcript.length);
	}

	async sendMessage(input: {
		chatKind: "dm" | "group";
		chatId?: string;
		senderId: string;
		senderName: string;
		text: string;
		replyToMessageId?: string;
		mentionBot?: boolean;
		attachments?: Array<{
			kind: "image" | "file";
			name?: string;
			mimeType?: string;
			bytes: Uint8Array;
		}>;
		attachment?: {
			kind: "image" | "file";
			name?: string;
			mimeType?: string;
			bytes: Uint8Array;
		};
	}): Promise<{ chatId: string; messageId: string }> {
		const messageId = String(this.messageCounter++);
		const chatId = input.chatId ?? (input.chatKind === "dm" ? input.senderId : "-100123");
		const segments: Array<{ type: string; data: Record<string, unknown> }> = [];
		const attachments = input.attachments ?? (input.attachment ? [input.attachment] : []);
		if (input.replyToMessageId) {
			segments.push({ type: "reply", data: { id: input.replyToMessageId } });
		}
		if (input.chatKind === "group" && input.mentionBot) {
			segments.push({ type: "at", data: { qq: this.selfId } });
			segments.push({ type: "text", data: { text: ` ${input.text}` } });
		} else {
			segments.push({ type: "text", data: { text: input.text } });
		}
		for (const attachment of attachments) {
			if (attachment.kind === "image") {
				const remoteUrl = `https://harness.invalid/napcat/${messageId}/${attachment.name ?? `image-${segments.length}.png`}`;
				this.registerRemoteBinary(remoteUrl, attachment.bytes);
				segments.push({
					type: "image",
					data: { url: remoteUrl, file: remoteUrl },
				});
				continue;
			}
			const remoteId = `napcat-file-${randomUUID()}`;
			this.client.registerFile(remoteId, {
				file: "",
				file_name: attachment.name ?? "attachment.bin",
				file_size: attachment.bytes.byteLength,
				base64: Buffer.from(attachment.bytes).toString("base64"),
			});
			segments.push({
				type: "file",
				data: {
					file: remoteId,
					name: attachment.name ?? "attachment.bin",
				},
			});
		}
		await this.client.emitInbound(
			input.chatKind === "dm" ? "message.private.friend" : "message.group.normal",
			{
				post_type: "message",
				message_type: input.chatKind === "dm" ? "private" : "group",
				sub_type: input.chatKind === "dm" ? "friend" : "normal",
				time: Math.floor(Date.now() / 1_000),
				self_id: Number(this.selfId),
				user_id: Number(input.senderId),
				group_id: input.chatKind === "group" ? Number(chatId) : undefined,
				message_id: Number(messageId),
				raw_message: input.chatKind === "group" && input.mentionBot ? `@bot ${input.text}` : input.text,
				message: segments,
				sender:
					input.chatKind === "group"
						? {
								user_id: Number(input.senderId),
								nickname: input.senderName,
								card: input.senderName,
								sex: "unknown",
								age: 0,
								area: "",
								level: "",
								role: "member",
								title: "",
							}
						: {
								user_id: Number(input.senderId),
								nickname: input.senderName,
							},
				anonymous: null,
			} as never,
		);
		return { chatId, messageId };
	}

	botUserId(): string {
		return this.selfId;
	}

	botUsername(): string | undefined {
		return undefined;
	}
}

function cloneAgentWorkspace(store: JsonNekoclawStore, source: AgentSpec, target: AgentSpec): void {
	const sourceRoot = store.getWorkspaceRoot(source.slug);
	const targetRoot = store.getWorkspaceRoot(target.slug);
	const files = ["SOUL.md", "AGENTS.md", "MEMORY.md"];
	for (const file of files) {
		const from = join(sourceRoot, file);
		const to = join(targetRoot, file);
		if (existsSync(from)) {
			cpSync(from, to, { force: true });
		}
	}
	const sourceSkills = join(sourceRoot, "skills");
	const targetSkills = join(targetRoot, "skills");
	rmSync(targetSkills, { recursive: true, force: true });
	mkdirSync(targetSkills, { recursive: true });
	if (existsSync(sourceSkills)) {
		cpSync(sourceSkills, targetSkills, { recursive: true, force: true });
	}
	const sourceRuntime = join(sourceRoot, ".nekoclaw-runtime");
	const targetRuntime = join(targetRoot, ".nekoclaw-runtime");
	rmSync(targetRuntime, { recursive: true, force: true });
	mkdirSync(targetRuntime, { recursive: true });
	if (existsSync(sourceRuntime)) {
		cpSync(sourceRuntime, targetRuntime, { recursive: true, force: true });
	}
	rmSync(join(targetRoot, "chats"), { recursive: true, force: true });
	mkdirSync(join(targetRoot, "chats"), { recursive: true });
}

function cloneAgentConfig(store: JsonNekoclawStore, source: AgentSpec): AgentSpec {
	const target = store.createAgent({
		slug: `${source.slug}-harness-${Date.now()}`,
		image: source.image,
	});
	cloneAgentWorkspace(store, source, target);
	const modelConfig = store.getModelConfig(source.agentId);
	if (modelConfig?.kind === "builtin") {
		store.setBuiltinModelConfig(target.agentId, {
			provider: modelConfig.provider,
			modelId: modelConfig.modelId,
			apiKey: modelConfig.apiKey,
			thinkingLevel: modelConfig.thinkingLevel,
		});
	} else if (modelConfig?.kind === "custom") {
		store.setCustomModelConfig(target.agentId, {
			baseUrl: modelConfig.baseUrl,
			api: modelConfig.api,
			providerId: modelConfig.providerId,
			modelId: modelConfig.modelId,
			apiKey: modelConfig.apiKey,
			thinkingLevel: modelConfig.thinkingLevel,
		});
		const runtimeModels = store.readRuntimeModelsConfig(source.agentId);
		if (runtimeModels) {
			store.writeRuntimeModelsConfig(target.agentId, runtimeModels, {
				copiedFrom: source.agentId,
				reason: "internal_chat_harness",
			});
		}
	}
	return store.updateAgent(target.agentId, { enabled: true, lastError: null });
}

async function createHarnessContext(options: InternalChatHarnessRunOptions): Promise<CurrentEnvHarnessContext> {
	const store = new JsonNekoclawStore();
	const source = store.getAgentByRef(options.agentRef);
	const agent = cloneAgentConfig(store, source);
	const fetchRegistry = installFetchRegistry();
	const plugins = new Map<string, ChannelPlugin>();
	const outboundDispatch = new OutboundDispatchService(store, plugins);
	const drivers = new Map<Exclude<HarnessChannel, "both">, HarnessDriver>();
	const requestedChannels: Array<Exclude<HarnessChannel, "both">> =
		options.channel === "both" || !options.channel ? ["telegram", "napcat"] : [options.channel];
	for (const channel of requestedChannels) {
		if (channel === "telegram") {
			const driver = new TelegramHarnessDriver(store, agent, (url, bytes) => fetchRegistry.register(url, bytes));
			drivers.set(channel, driver);
			plugins.set(getRuntimeKey(agent.agentId, channel), driver.plugin);
			continue;
		}
		const driver = new NapcatHarnessDriver(store, agent, (url, bytes) => fetchRegistry.register(url, bytes));
		drivers.set(channel, driver);
		plugins.set(getRuntimeKey(agent.agentId, channel), driver.plugin);
	}
	const workerRunner =
		options.executeJob === undefined
			? new WorkerRunnerService(
					store,
					outboundDispatch,
					plugins,
					async (agentRef) => {
						const current = store.getAgentByRef(agentRef);
						return ensureAgentContainer(current, store.getWorkspaceRoot(current.slug));
					},
				)
			: undefined;
	const jobQueue = new JobQueueService(
		store,
		new Map<string, RunJob[]>(),
		new Set<string>(),
		async (job) => {
			if (options.executeJob) {
				const result = await options.executeJob(job, {
					store,
					agent,
					outboundDispatch,
					jobQueue,
					plugins,
					drivers,
					timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
					workspaceRoot: store.getWorkspaceRoot(agent.slug),
					createWorkspaceFixture(input) {
						const hostPath = join(store.getWorkspaceRoot(agent.slug), input.relativePath);
						mkdirSync(dirname(hostPath), { recursive: true });
						writeFileSync(hostPath, input.bytes);
						return {
							relativePath: input.relativePath,
							hostPath,
							containerPath: `${NEKOCLAW_CONTAINER_WORKSPACE_DIR}/${input.relativePath.replace(/\\/g, "/")}`,
						};
					},
				});
				const session = store.getSession(agent.agentId, job.sessionRecordId);
				if (result.toolActions?.length) {
					await outboundDispatch.executeToolActions(agent, session, result.toolActions);
				}
				if (result.outbound.text?.trim() || result.outbound.attachments?.length) {
					await outboundDispatch.sendToSession(agent, session, job.event, result.outbound);
				}
				return result;
			}
			assertCondition(workerRunner, "Expected a worker runner when executeJob override is not provided");
			return workerRunner.runJob(job);
		},
	);
	jobQueue.initialize();
	const commands = new CommandRouterService(store, (agentId) => jobQueue.getStatus(agentId));
	const messageRouter = new MessageRouterService(store, plugins, commands, (job) => jobQueue.enqueue(job));
	for (const [channel, driver] of drivers.entries()) {
		driver.plugin.startPolling({
			onEvent: async (event) => {
				await messageRouter.handleInbound(agent.agentId, channel, event);
			},
			onError: (error) => {
				store.updateAgent(agent.agentId, { lastError: error.message });
			},
		});
	}
	return {
		store,
		agent,
		outboundDispatch,
		jobQueue,
		plugins,
		drivers,
		timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		workspaceRoot: store.getWorkspaceRoot(agent.slug),
		createWorkspaceFixture(input) {
			const hostPath = join(store.getWorkspaceRoot(agent.slug), input.relativePath);
			mkdirSync(dirname(hostPath), { recursive: true });
			writeFileSync(hostPath, input.bytes);
			return {
				relativePath: input.relativePath,
				hostPath,
				containerPath: `${NEKOCLAW_CONTAINER_WORKSPACE_DIR}/${input.relativePath.replace(/\\/g, "/")}`,
			};
		},
		_restoreFetchRegistry: fetchRegistry.restore,
	};
}

async function disposeHarnessContext(context: CurrentEnvHarnessContext): Promise<void> {
	const extended = context as CurrentEnvHarnessContext & { _restoreFetchRegistry?: () => void };
	for (const driver of context.drivers.values()) {
		driver.plugin.stop();
	}
	await removeAgentContainer(context.agent.containerName).catch(() => undefined);
	extended._restoreFetchRegistry?.();
}

function collectEvidence(context: ScenarioContext): InternalChatHarnessEvidence {
	return {
		transcript: tail(context.driver.getTranscript(), 40),
		pairs: context.store.listPairRequests(context.agent.agentId),
		queueTail: tail(context.store.getQueueEvents(context.agent.agentId), 20),
		auditTail: tail(context.store.getAuditEntries(context.agent.agentId), 20),
		sessionLogTail: readSessionLogTail(context.store, context.agent, 20),
		lastError: context.store.getAgentByRef(context.agent.agentId).lastError,
		sandboxAgentSlug: context.agent.slug,
	};
}

export async function runChatHarnessInCurrentEnvironment(
	options: InternalChatHarnessRunOptions,
): Promise<InternalChatHarnessReport> {
	const startedAt = nowIso();
	const context = await createHarnessContext(options);
	const picked = pickScenarioNames(options.scenario, SCENARIOS);
	const requestedChannels = options.channel === "both" || !options.channel ? new Set(["telegram", "napcat"]) : new Set([options.channel]);
	const results: InternalChatHarnessScenarioResult[] = [];
	try {
		for (const scenario of SCENARIOS) {
			if (!requestedChannels.has(scenario.channel)) {
				continue;
			}
			if (picked && !picked.has(scenario.name)) {
				continue;
			}
			const driver = context.drivers.get(scenario.channel);
			const start = Date.now();
			if (!driver) {
				results.push({
					name: scenario.name,
					channel: scenario.channel,
					status: "skipped",
					durationMs: Date.now() - start,
					evidence: {
						transcript: [],
						pairs: [],
						queueTail: [],
						auditTail: [],
						sessionLogTail: [],
						lastError: undefined,
						sandboxAgentSlug: context.agent.slug,
					},
				});
				continue;
			}
			driver.clearTranscript();
			const scenarioContext: ScenarioContext = {
				...context,
				channel: scenario.channel,
				driver,
				dmChatId: String(100123 + results.length + 1),
				groupChatId: String(-100123 - (results.length + 1)),
				dmUserId: String(10001 + results.length + 1),
				groupUserId: String(20001 + results.length + 1),
				adminUserId: String(90001 + results.length + 1),
			};
			presetGroupTrigger(scenarioContext, "all");
			try {
				await scenario.run(scenarioContext);
				const outbound = [...driver.getTranscript()].reverse().find((entry) => entry.kind === "outbound");
				results.push({
					name: scenario.name,
					channel: scenario.channel,
					status: "passed",
					durationMs: Date.now() - start,
					outboundPreview: outbound?.text,
					evidence: collectEvidence(scenarioContext),
				});
			} catch (error) {
				results.push({
					name: scenario.name,
					channel: scenario.channel,
					status: "failed",
					durationMs: Date.now() - start,
					error: error instanceof Error ? error.message : String(error),
					outboundPreview:
						latestOutbound(driver, scenarioContext.dmChatId)?.text ??
						latestOutbound(driver, scenarioContext.groupChatId)?.text,
					evidence: collectEvidence(scenarioContext),
				});
			}
		}
	} finally {
		await disposeHarnessContext(context);
	}
	return {
		ok: results.every((result) => result.status !== "failed"),
		agentRef: options.agentRef,
		agentSlug: context.agent.slug,
		startedAt,
		finishedAt: nowIso(),
		results,
	};
}
