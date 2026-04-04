import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeModelsConfig } from "../src/model/model-types.js";

function formatCompactNumber(value: number): string {
	const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
	return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function formatCompactTokens(value: number): string {
	if (value >= 1_000_000) {
		return `${formatCompactNumber(value / 1_000_000)}m`;
	}
	if (value >= 1_000) {
		return `${formatCompactNumber(value / 1_000)}k`;
	}
	return value.toLocaleString("en-US");
}

describe("runtime command router", () => {
	let tempHome: string;
	const originalHome = process.env.HOME;
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		tempHome = mkdtempSync(join(tmpdir(), "nekoclaw-command-router-"));
		process.env.HOME = tempHome;
		vi.resetModules();
		fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith("/models")) {
				if (url.includes("openrouter.example")) {
					return new Response(
						JSON.stringify({
							data: [
								{
									id: "qwen/qwen3.6-plus:free",
									name: "Qwen 3.6 Plus Free",
									context_length: 200000,
									top_provider: {
										max_completion_tokens: 16000,
									},
								},
							],
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					);
				}
				return new Response(JSON.stringify({ data: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			if (url.endsWith("/responses/input_tokens")) {
				const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string };
				return new Response(
					JSON.stringify({
						object: "response.input_tokens",
						input_tokens: typeof body.input === "string" ? body.input.length : 0,
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			if (url.endsWith("/v1/messages/count_tokens")) {
				const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ content?: string }> };
				const text = body.messages?.[0]?.content ?? "";
				return new Response(JSON.stringify({ input_tokens: text.length }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response("not found", { status: 404 });
		});
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		rmSync(tempHome, { recursive: true, force: true });
	});

	it("returns status for a paired non-admin user and includes the platform user id", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { CommandRouterService } = await import("../src/runtime/command-router.js");
		const { TokenService } = await import("../src/runtime/token-service.js");
		const store = new JsonNekoclawStore();
		store.createAgent({ slug: "status-cat" });
		const agent = store.setBuiltinModelConfig("status-cat", { provider: "openai", modelId: "gpt-5" });
		const session = store.createSession(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "123",
			chatKind: "dm",
		});
		writeFileSync(
			store.getSessionContextPath(agent.slug, session.sessionRecordId),
			[
				JSON.stringify({ type: "session_info", id: "1" }),
				JSON.stringify({ type: "compaction", id: "2", summary: "summary", firstKeptEntryId: "1", tokensBefore: 100 }),
			].join("\n"),
			"utf-8",
		);
		const reply = vi.fn(async () => []);
		const router = new CommandRouterService(store, () => ({ queued: 2, processing: true, currentJobId: "job-1" }));

		const handled = await router.handleCommand(
			agent,
			{
				actions: { reply },
			} as never,
			{
				eventType: "message.created",
				channelType: "telegram",
				chatId: "123",
				chatKind: "dm",
				messageId: "99",
				sender: { externalId: "777", displayName: "Alice" },
				blocks: [{ kind: "text", text: "/status" }],
				occurredAt: "2026-03-29T00:00:00.000Z",
			},
			session,
		);

		expect(handled).toBe(true);
		expect(reply).toHaveBeenCalledTimes(1);
		const contextWindow = new TokenService(store).resolveEffectiveModel(agent, session)?.contextWindow;
		expect(contextWindow).toBeGreaterThan(0);
		expect(reply.mock.calls[0]?.[0]?.payload?.text).toContain("Platform user id: 777");
		expect(reply.mock.calls[0]?.[0]?.payload?.text).toContain("Channel trigger: all");
		expect(reply.mock.calls[0]?.[0]?.payload?.text).toContain("Channel trigger: all");
		expect(reply.mock.calls[0]?.[0]?.payload?.text).toContain(`Session key: ${session.sessionKey}`);
		expect(reply.mock.calls[0]?.[0]?.payload?.text).toContain("running_sessions=");
		expect(reply.mock.calls[0]?.[0]?.payload?.text).toContain("Active runs:");
		expect(reply.mock.calls[0]?.[0]?.payload?.text).toContain("Compaction: enabled=yes");
		expect(reply.mock.calls[0]?.[0]?.payload?.text).toContain("Compaction reserveTokens: 20000");
		expect(reply.mock.calls[0]?.[0]?.payload?.text).toContain("Compaction keepRecentTokens: 20000");
		expect(reply.mock.calls[0]?.[0]?.payload?.text).toContain(`Context: 0/${formatCompactTokens(contextWindow ?? 0)} (0%)`);
		expect(reply.mock.calls[0]?.[0]?.payload?.text).not.toContain("Context file size:");
		expect(reply.mock.calls[0]?.[0]?.payload?.text).toContain("Compactions: 1");
		expect(reply.mock.calls[0]?.[0]?.payload?.text).toContain("Pruning: enabled");
	}, 10_000);

	it("returns status for a command with leading whitespace representing stripped map mentions", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { CommandRouterService } = await import("../src/runtime/command-router.js");
		const store = new JsonNekoclawStore();
		store.createAgent({ slug: "status-space-cat" });
		const agent = store.setBuiltinModelConfig("status-space-cat", { provider: "openai", modelId: "gpt-5" });
		const session = store.createSession(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "123",
			chatKind: "dm",
		});
		const reply = vi.fn(async () => []);
		const router = new CommandRouterService(store, () => ({ queued: 2, processing: true, currentJobId: "job-1" }));

		const handled = await router.handleCommand(
			agent,
			{
				actions: { reply },
			} as never,
			{
				eventType: "message.created",
				channelType: "telegram",
				chatId: "123",
				chatKind: "dm",
				messageId: "99",
				sender: { externalId: "777", displayName: "Alice" },
				blocks: [{ kind: "text", text: "  /status  " }], // Notice leading spaces
				occurredAt: "2026-03-29T00:00:00.000Z",
			},
			session,
		);

		expect(handled).toBe(true);
		expect(reply).toHaveBeenCalledTimes(1);
	});

	it("uses the session override model when resolving status context limits", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { CommandRouterService } = await import("../src/runtime/command-router.js");
		const { TokenService } = await import("../src/runtime/token-service.js");
		const store = new JsonNekoclawStore();
		store.createAgent({ slug: "status-override-cat" });
		const agent = store.setBuiltinModelConfig("status-override-cat", { provider: "openai", modelId: "gpt-5", apiKey: "test-key" });
		const session = store.createSession(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "123",
			chatKind: "dm",
		});
		store.setSessionModelOverride(agent.agentId, session.sessionRecordId, {
			provider: "openai",
			modelId: "gpt-5-mini",
		});
		writeFileSync(store.getSessionContextPath(agent.slug, session.sessionRecordId), JSON.stringify({ hello: "world" }), "utf-8");
		const reply = vi.fn(async () => []);
		const router = new CommandRouterService(store, () => ({ queued: 0, processing: false, currentJobId: undefined }));

		await router.handleCommand(
			agent,
			{
				actions: { reply },
			} as never,
			{
				eventType: "message.created",
				channelType: "telegram",
				chatId: "123",
				chatKind: "dm",
				messageId: "199",
				sender: { externalId: "777", displayName: "Alice" },
				blocks: [{ kind: "text", text: "/status" }],
				occurredAt: "2026-03-29T00:00:00.000Z",
			},
			store.getSession(agent.agentId, session.sessionRecordId),
		);

		const contextWindow = new TokenService(store).resolveEffectiveModel(store.getAgentByRef(agent.agentId), store.getSession(agent.agentId, session.sessionRecordId))?.contextWindow;
		expect(contextWindow).toBeGreaterThan(0);
		expect(reply.mock.calls[0]?.[0]?.payload?.text).toContain("Effective model: openai/gpt-5-mini (session override)");
		expect(reply.mock.calls[0]?.[0]?.payload?.text).toContain(`Context: 0/${formatCompactTokens(contextWindow ?? 0)} (0%)`);
	});

	it("shows unknown context when the effective model has no context window metadata", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { CommandRouterService } = await import("../src/runtime/command-router.js");
		const store = new JsonNekoclawStore();
		store.createAgent({ slug: "status-custom-cat" });
		const agent = store.setCustomModelConfig("status-custom-cat", {
			baseUrl: "https://example.invalid/v1",
			api: "openai-completions",
			providerId: "custom-ai",
			modelId: "custom-1",
			apiKey: "test-key",
		});
		const session = store.createSession(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "123",
			chatKind: "dm",
		});
		writeFileSync(store.getSessionContextPath(agent.slug, session.sessionRecordId), JSON.stringify({ hello: "world" }), "utf-8");
		const reply = vi.fn(async () => []);
		const router = new CommandRouterService(store, () => ({ queued: 0, processing: false, currentJobId: undefined }));

		await router.handleCommand(
			agent,
			{
				actions: { reply },
			} as never,
			{
				eventType: "message.created",
				channelType: "telegram",
				chatId: "123",
				chatKind: "dm",
				messageId: "200",
				sender: { externalId: "777", displayName: "Alice" },
				blocks: [{ kind: "text", text: "/status" }],
				occurredAt: "2026-03-29T00:00:00.000Z",
			},
			session,
		);

		expect(reply.mock.calls[0]?.[0]?.payload?.text).toContain("Context: 0/?");
	});

	it("reads the latest usage snapshot from context jsonl for status context usage", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { CommandRouterService } = await import("../src/runtime/command-router.js");
		const { TokenService } = await import("../src/runtime/token-service.js");
		const store = new JsonNekoclawStore();
		store.createAgent({ slug: "status-usage-cat" });
		const agent = store.setBuiltinModelConfig("status-usage-cat", { provider: "openai", modelId: "gpt-5" });
		const session = store.createSession(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "333",
			chatKind: "dm",
		});
		writeFileSync(
			store.getSessionContextPath(agent.slug, session.sessionRecordId),
			[
				JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 1200, totalTokens: 1400 } } }),
				JSON.stringify({ type: "compaction", id: "compact-1" }),
				JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 14519, totalTokens: 14739 } } }),
			].join("\n"),
			"utf-8",
		);
		const reply = vi.fn(async () => []);
		const router = new CommandRouterService(store, () => ({ queued: 0, processing: false, currentJobId: undefined }));

		await router.handleCommand(
			agent,
			{ actions: { reply } } as never,
			{
				eventType: "message.created",
				channelType: "telegram",
				chatId: "333",
				chatKind: "dm",
				messageId: "201",
				sender: { externalId: "777", displayName: "Alice" },
				blocks: [{ kind: "text", text: "/status" }],
				occurredAt: "2026-03-29T00:00:00.000Z",
			},
			session,
		);

		const contextWindow = new TokenService(store).resolveEffectiveModel(agent, session)?.contextWindow;
		expect(contextWindow).toBeGreaterThan(0);
		expect(reply.mock.calls[0]?.[0]?.payload?.text).toContain(`Context: ${formatCompactTokens(14519)}/${formatCompactTokens(contextWindow ?? 0)}`);
		expect(reply.mock.calls[0]?.[0]?.payload?.text).toContain("Compactions: 1");
	});

	it("refreshes custom openai-compatible model metadata and persists context window for status", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { CommandRouterService } = await import("../src/runtime/command-router.js");
		const store = new JsonNekoclawStore();
		store.createAgent({ slug: "status-openrouter-cat" });
		const agent = store.setCustomModelConfig("status-openrouter-cat", {
			baseUrl: "https://openrouter.example/api/v1",
			api: "openai-completions",
			providerId: "openrouter-direct",
			modelId: "qwen/qwen3.6-plus:free",
			apiKey: "test-key",
		});
		const session = store.createSession(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "456",
			chatKind: "dm",
		});
		store.writeRuntimeModelsConfig(
			agent.agentId,
			{
				providers: {
					"openrouter-direct": {
						baseUrl: "https://openrouter.example/api/v1",
						api: "openai-completions",
						apiKey: "NEKOCLAW_CUSTOM_MODEL_API_KEY",
						authHeader: true,
						models: [{ id: "qwen/qwen3.6-plus:free", name: "qwen/qwen3.6-plus:free" }],
					},
				},
			},
			{},
		);
		writeFileSync(
			store.getSessionContextPath(agent.slug, session.sessionRecordId),
			JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 19364, totalTokens: 19394 } } }),
			"utf-8",
		);
		const reply = vi.fn(async () => []);
		const router = new CommandRouterService(store, () => ({ queued: 0, processing: false, currentJobId: undefined }));

		await router.handleCommand(
			agent,
			{ actions: { reply } } as never,
			{
				eventType: "message.created",
				channelType: "telegram",
				chatId: "456",
				chatKind: "dm",
				messageId: "202",
				sender: { externalId: "777", displayName: "Alice" },
				blocks: [{ kind: "text", text: "/status" }],
				occurredAt: "2026-03-29T00:00:00.000Z",
			},
			session,
		);

		expect(reply.mock.calls[0]?.[0]?.payload?.text).toContain(`Context: ${formatCompactTokens(19364)}/200k (9.7%)`);
		const runtimeConfig = store.readRuntimeModelsConfig(agent.agentId) as RuntimeModelsConfig;
		const model = runtimeConfig.providers["openrouter-direct"]?.models?.find((entry) => entry.id === "qwen/qwen3.6-plus:free");
		expect(model?.contextWindow).toBe(200000);
		expect(model?.maxTokens).toBe(16000);
	});

	it("returns status for a group command prefixed by a mention token", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { CommandRouterService } = await import("../src/runtime/command-router.js");
		const store = new JsonNekoclawStore();
		store.createAgent({ slug: "status-mention-cat" });
		const agent = store.setBuiltinModelConfig("status-mention-cat", { provider: "openai", modelId: "gpt-5" });
		const session = store.createSession(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "-1001",
			chatKind: "group",
		});
		const reply = vi.fn(async () => []);
		const router = new CommandRouterService(store, () => ({ queued: 0, processing: false, currentJobId: undefined }));

		const handled = await router.handleCommand(
			agent,
			{
				actions: { reply },
			} as never,
			{
				eventType: "message.created",
				channelType: "telegram",
				chatId: "-1001",
				chatKind: "group",
				messageId: "109",
				sender: { externalId: "777", displayName: "Alice" },
				blocks: [{ kind: "text", text: "@mybot /status" }],
				mentionedUsernames: ["mybot"],
				occurredAt: "2026-03-29T00:00:00.000Z",
			},
			session,
		);

	expect(handled).toBe(true);
	expect(reply).toHaveBeenCalledTimes(1);
	expect(reply.mock.calls[0]?.[0]?.payload?.text).toContain(`Session key: ${session.sessionKey}`);
});

	it("passes chatKind when replying to a napcat group command", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { CommandRouterService } = await import("../src/runtime/command-router.js");
		const store = new JsonNekoclawStore();
		store.createAgent({ slug: "status-napcat-group-cat" });
		const agent = store.setBuiltinModelConfig("status-napcat-group-cat", { provider: "openai", modelId: "gpt-5" });
		const session = store.createSession(agent.agentId, {
			channelType: "napcat",
			externalConversationId: "1063820039",
			chatKind: "group",
		});
		const reply = vi.fn(async () => []);
		const router = new CommandRouterService(store, () => ({ queued: 0, processing: false, currentJobId: undefined }));

		const handled = await router.handleCommand(
			agent,
			{
				actions: { reply },
			} as never,
			{
				eventType: "message.created",
				channelType: "napcat",
				chatId: "1063820039",
				chatKind: "group",
				messageId: "1027970871",
				mentionedUserIds: ["3794477609"],
				sender: { externalId: "123456789", displayName: "testuser" },
				blocks: [{ kind: "text", text: "/status" }],
				occurredAt: "2026-03-29T00:00:00.000Z",
			},
			session,
		);

		expect(handled).toBe(true);
		expect(reply).toHaveBeenCalledWith(
			expect.objectContaining({
				chatId: "1063820039",
				chatKind: "group",
				replyToId: "1027970871",
			}),
		);
	});

	it("returns a concise help message and includes admin-only commands for admins", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { CommandRouterService } = await import("../src/runtime/command-router.js");
		const store = new JsonNekoclawStore();
		store.createAgent({ slug: "help-cat" });
		const agent = store.setBuiltinModelConfig("help-cat", { provider: "openai", modelId: "gpt-5" });
		store.addAdmin(agent.agentId, { channelType: "telegram", externalUserId: "9001" });
		const reply = vi.fn(async () => []);
		const router = new CommandRouterService(store, () => ({ queued: 0, processing: false, currentJobId: undefined }));

		await router.handleCommand(
			agent,
			{
				actions: { reply },
			} as never,
			{
				eventType: "message.created",
				channelType: "telegram",
				chatId: "123",
				chatKind: "dm",
				messageId: "107",
				sender: { externalId: "9001" },
				blocks: [{ kind: "text", text: "/help" }],
				occurredAt: "2026-03-29T00:00:00.000Z",
			},
			undefined,
		);

		const text = reply.mock.calls[0]?.[0]?.payload?.text as string;
		expect(text).toContain("/help - Show this command list");
		expect(text).toContain("/status - Show session status and your platform user id");
		expect(text).toContain("/pair - Pair the current chat if it is not paired yet");
		expect(text).toContain("/stop - Clear queued follow-up tasks for the current session");
		expect(text).toContain("/trigger mention - Trigger only on mentions for this channel");
	});

	it("clears queued follow-up tasks for the current session through /stop", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { CommandRouterService } = await import("../src/runtime/command-router.js");
		const store = new JsonNekoclawStore();
		store.createAgent({ slug: "stop-cat" });
		const agent = store.setBuiltinModelConfig("stop-cat", { provider: "openai", modelId: "gpt-5" });
		const session = store.createSession(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "123",
			chatKind: "dm",
		});
		const reply = vi.fn(async () => []);
		const stopSession = vi.fn(() => ({ removedQueuedCount: 2, hadQueuedWork: true }));
		const router = new CommandRouterService(store, () => ({ queued: 0, processing: false, currentJobId: undefined }), stopSession);

		const handled = await router.handleCommand(
			agent,
			{
				actions: { reply },
			} as never,
			{
				eventType: "message.created",
				channelType: "telegram",
				chatId: "123",
				chatKind: "dm",
				messageId: "199",
				sender: { externalId: "777", displayName: "Alice" },
				blocks: [{ kind: "text", text: "/stop" }],
				occurredAt: "2026-03-29T00:00:00.000Z",
			},
			session,
		);

		expect(handled).toBe(true);
		expect(stopSession).toHaveBeenCalledWith(agent.agentId, session.sessionRecordId);
		expect(reply.mock.calls[0]?.[0]?.payload?.text).toBe("已停止当前会话的后续任务：清除了 2 个排队任务。");
	});

	it("returns a no-op message for /stop when the chat is not paired", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { CommandRouterService } = await import("../src/runtime/command-router.js");
		const store = new JsonNekoclawStore();
		store.createAgent({ slug: "stop-unpaired-cat" });
		const agent = store.setBuiltinModelConfig("stop-unpaired-cat", { provider: "openai", modelId: "gpt-5" });
		const reply = vi.fn(async () => []);
		const stopSession = vi.fn(() => ({ removedQueuedCount: 0, hadQueuedWork: false }));
		const router = new CommandRouterService(store, () => ({ queued: 0, processing: false, currentJobId: undefined }), stopSession);

		const handled = await router.handleCommand(
			agent,
			{
				actions: { reply },
			} as never,
			{
				eventType: "message.created",
				channelType: "telegram",
				chatId: "123",
				chatKind: "dm",
				messageId: "200",
				sender: { externalId: "777", displayName: "Alice" },
				blocks: [{ kind: "text", text: "/stop" }],
				occurredAt: "2026-03-29T00:00:00.000Z",
			},
			undefined,
		);

		expect(handled).toBe(true);
		expect(stopSession).not.toHaveBeenCalled();
		expect(reply.mock.calls[0]?.[0]?.payload?.text).toBe("当前会话没有正在排队的任务。");
	});

	it("creates a real pair prompt for an unpaired /pair command", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { CommandRouterService } = await import("../src/runtime/command-router.js");
		const store = new JsonNekoclawStore();
		store.createAgent({ slug: "pair-cat" });
		const agent = store.setBuiltinModelConfig("pair-cat", { provider: "openai", modelId: "gpt-5" });
		const reply = vi.fn(async () => []);
		const router = new CommandRouterService(store, () => ({ queued: 0, processing: false, currentJobId: undefined }));

		const handled = await router.handleCommand(
			agent,
			{
				actions: { reply },
				resolveSessionAddress: (event) => ({
					channelType: event.channelType,
					externalConversationId: event.chatId,
					chatKind: event.chatKind,
				}),
				pairing: {
					shouldOfferPair: () => true,
					buildPairPrompt: (pair) => ({ text: `pair code ${pair.code}` }),
					buildPairAccepted: () => ({ text: "accepted" }),
					buildPairRejected: () => ({ text: "rejected" }),
				},
			} as never,
			{
				eventType: "message.created",
				channelType: "telegram",
				chatId: "-1005",
				chatKind: "group",
				messageId: "107",
				sender: { externalId: "9" },
				blocks: [{ kind: "text", text: "/pair" }],
				occurredAt: "2026-03-29T00:00:00.000Z",
			},
			undefined,
		);

		expect(handled).toBe(true);
		expect(reply).toHaveBeenCalledTimes(1);
		expect(reply.mock.calls[0]?.[0]?.payload?.text).toContain("pair code");
		expect(store.listPairRequests(agent.agentId)).toHaveLength(1);
	});

	it("reports that /pair is already connected when a session already exists", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { CommandRouterService } = await import("../src/runtime/command-router.js");
		const store = new JsonNekoclawStore();
		store.createAgent({ slug: "paired-cat" });
		const agent = store.setBuiltinModelConfig("paired-cat", { provider: "openai", modelId: "gpt-5" });
		const session = store.createSession(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "-1006",
			chatKind: "group",
		});
		const reply = vi.fn(async () => []);
		const router = new CommandRouterService(store, () => ({ queued: 0, processing: false, currentJobId: undefined }));

		await router.handleCommand(
			agent,
			{
				actions: { reply },
				resolveSessionAddress: (event) => ({
					channelType: event.channelType,
					externalConversationId: event.chatId,
					chatKind: event.chatKind,
				}),
				pairing: {
					shouldOfferPair: () => true,
					buildPairPrompt: () => ({ text: "pair" }),
					buildPairAccepted: () => ({ text: "accepted" }),
					buildPairRejected: () => ({ text: "rejected" }),
				},
			} as never,
			{
				eventType: "message.created",
				channelType: "telegram",
				chatId: "-1006",
				chatKind: "group",
				messageId: "108",
				sender: { externalId: "9" },
				blocks: [{ kind: "text", text: "/pair" }],
				occurredAt: "2026-03-29T00:00:00.000Z",
			},
			session,
		);

		expect(reply.mock.calls[0]?.[0]?.payload?.text).toContain("already paired");
		expect(reply.mock.calls[0]?.[0]?.payload?.text).toContain(session.sessionKey);
	});

	it("allows admins to run status in an unpaired chat and reports session none", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { CommandRouterService } = await import("../src/runtime/command-router.js");
		const store = new JsonNekoclawStore();
		store.createAgent({ slug: "admin-cat" });
		const agent = store.setBuiltinModelConfig("admin-cat", { provider: "openai", modelId: "gpt-5" });
		store.addAdmin(agent.agentId, { channelType: "telegram", externalUserId: "9001" });
		const reply = vi.fn(async () => []);
		const router = new CommandRouterService(store, () => ({ queued: 0, processing: false, currentJobId: undefined }));

		await router.handleCommand(
			agent,
			{
				actions: { reply },
			} as never,
			{
				eventType: "message.created",
				channelType: "telegram",
				chatId: "-1001",
				chatKind: "group",
				messageId: "100",
				sender: { externalId: "9001", displayName: "Boss" },
				blocks: [{ kind: "text", text: "/status@mybot" }],
				occurredAt: "2026-03-29T00:00:00.000Z",
			},
			undefined,
		);

		expect(reply).toHaveBeenCalledTimes(1);
		expect(reply.mock.calls[0]?.[0]?.payload?.text).toContain("Role: admin");
		expect(reply.mock.calls[0]?.[0]?.payload?.text).toContain("Session key: none");
	});

	it("rejects status for a non-admin user in an unpaired chat", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { CommandRouterService } = await import("../src/runtime/command-router.js");
		const store = new JsonNekoclawStore();
		const agent = store.createAgent({ slug: "lonely-cat" });
		const reply = vi.fn(async () => []);
		const router = new CommandRouterService(store, () => ({ queued: 0, processing: false, currentJobId: undefined }));

		await router.handleCommand(
			agent,
			{
				actions: { reply },
			} as never,
			{
				eventType: "message.created",
				channelType: "telegram",
				chatId: "-1002",
				chatKind: "group",
				messageId: "101",
				sender: { externalId: "222" },
				blocks: [{ kind: "text", text: "/status" }],
				occurredAt: "2026-03-29T00:00:00.000Z",
			},
			undefined,
		);

		expect(reply.mock.calls[0]?.[0]?.payload?.text).toContain("not paired yet");
	});

	it("resets the session context and clears the session model override", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { CommandRouterService } = await import("../src/runtime/command-router.js");
		const store = new JsonNekoclawStore();
		store.createAgent({ slug: "reset-cat" });
		const agent = store.setBuiltinModelConfig("reset-cat", { provider: "openai", modelId: "gpt-5" });
		store.addAdmin(agent.agentId, { channelType: "telegram", externalUserId: "1" });
		const session = store.createSession(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "555",
			chatKind: "dm",
		});
		store.setSessionModelOverride(agent.agentId, session.sessionRecordId, {
			provider: "openai",
			modelId: "gpt-5-mini",
		});
		writeFileSync(store.getSessionContextPath(agent.slug, session.sessionRecordId), "{\"role\":\"user\"}\n", "utf-8");
		const reply = vi.fn(async () => []);
		const router = new CommandRouterService(store, () => ({ queued: 0, processing: false, currentJobId: undefined }));

		await router.handleCommand(
			agent,
			{
				actions: { reply },
			} as never,
			{
				eventType: "message.created",
				channelType: "telegram",
				chatId: "555",
				chatKind: "dm",
				messageId: "102",
				sender: { externalId: "1" },
				blocks: [{ kind: "text", text: "/reset" }],
				occurredAt: "2026-03-29T00:00:00.000Z",
			},
			session,
		);

		expect(readFileSync(store.getSessionContextPath(agent.slug, session.sessionRecordId), "utf-8")).toBe("");
		expect(store.getSession(agent.agentId, session.sessionRecordId).modelOverride).toBeUndefined();
		expect(reply.mock.calls[0]?.[0]?.payload?.text).toContain("Session reset.");
	});

	it("sets a session-scoped model override and updates the agent default model globally", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { CommandRouterService } = await import("../src/runtime/command-router.js");
		const store = new JsonNekoclawStore();
		store.createAgent({ slug: "model-cat" });
		const agent = store.setBuiltinModelConfig("model-cat", { provider: "openai", modelId: "gpt-5" });
		store.addAdmin(agent.agentId, { channelType: "telegram", externalUserId: "42" });
		const session = store.createSession(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "777",
			chatKind: "dm",
		});
		const reply = vi.fn(async () => []);
		const router = new CommandRouterService(store, () => ({ queued: 0, processing: false, currentJobId: undefined }));

		await router.handleCommand(
			agent,
			{
				actions: { reply },
			} as never,
			{
				eventType: "message.created",
				channelType: "telegram",
				chatId: "777",
				chatKind: "dm",
				messageId: "103",
				sender: { externalId: "42" },
				blocks: [{ kind: "text", text: "/model openai/gpt-5" }],
				occurredAt: "2026-03-29T00:00:00.000Z",
			},
			session,
		);
		expect(store.getSession(agent.agentId, session.sessionRecordId).modelOverride).toMatchObject({
			provider: "openai",
			modelId: "gpt-5",
		});

		await router.handleCommand(
			store.getAgentByRef(agent.agentId),
			{
				actions: { reply },
			} as never,
			{
				eventType: "message.created",
				channelType: "telegram",
				chatId: "-2000",
				chatKind: "group",
				messageId: "104",
				sender: { externalId: "42" },
				blocks: [{ kind: "text", text: "/model --global openai/gpt-5" }],
				occurredAt: "2026-03-29T00:00:00.000Z",
			},
			undefined,
		);

		const updatedAgent = store.getAgentByRef(agent.agentId);
		expect(updatedAgent.provider).toBe("openai");
		expect(updatedAgent.modelId).toBe("gpt-5");
	});

	it("upserts custom runtime models without fabricating metadata", async () => {
		const { NEKOCLAW_CUSTOM_MODEL_API_KEY_ENV } = await import("../src/config.js");
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { CommandRouterService } = await import("../src/runtime/command-router.js");
		const store = new JsonNekoclawStore();
		store.createAgent({ slug: "custom-model-cat" });
		const agent = store.setCustomModelConfig("custom-model-cat", {
			baseUrl: "https://proxy.example/v1",
			api: "openai-completions",
			providerId: "custom-ai",
			modelId: "claude-sonnet-4-6",
			apiKey: "secret-key",
		});
		store.addAdmin(agent.agentId, { channelType: "telegram", externalUserId: "42" });
		const session = store.createSession(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "777",
			chatKind: "dm",
		});
		store.writeRuntimeModelsConfig(
			agent.agentId,
			{
				providers: {
					"custom-ai": {
						baseUrl: "https://proxy.example/v1",
						api: "openai-completions",
						apiKey: NEKOCLAW_CUSTOM_MODEL_API_KEY_ENV,
						authHeader: true,
						compat: {
							supportsDeveloperRole: true,
						},
						models: [],
					},
				},
			},
			{},
		);
		const reply = vi.fn(async () => []);
		const router = new CommandRouterService(store, () => ({ queued: 0, processing: false, currentJobId: undefined }));

		await router.handleCommand(
			store.getAgentByRef(agent.agentId),
			{
				actions: { reply },
			} as never,
			{
				eventType: "message.created",
				channelType: "telegram",
				chatId: "777",
				chatKind: "dm",
				messageId: "205",
				sender: { externalId: "42" },
				blocks: [{ kind: "text", text: "/model custom-ai/claude-opus-4-1" }],
				occurredAt: "2026-03-29T00:00:00.000Z",
			},
			session,
		);

		const runtimeConfig = store.readRuntimeModelsConfig(agent.agentId) as {
			providers: Record<
				string,
				{
					compat?: Record<string, unknown>;
					models?: Array<Record<string, unknown>>;
				}
			>;
		};
		const provider = runtimeConfig.providers["custom-ai"];
		const model = provider.models?.find((entry) => entry.id === "claude-opus-4-1");

		expect(provider.compat).toEqual({ supportsDeveloperRole: true });
		expect(model).toEqual({
			id: "claude-opus-4-1",
			name: "claude-opus-4-1",
		});
		expect(model).not.toHaveProperty("contextWindow");
		expect(model).not.toHaveProperty("maxTokens");
		expect(model).not.toHaveProperty("cost");
	});

	it("updates the current channel group trigger through chat commands", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { CommandRouterService } = await import("../src/runtime/command-router.js");
		const store = new JsonNekoclawStore();
		store.createAgent({ slug: "trigger-cat" });
		const agent = store.setBuiltinModelConfig("trigger-cat", { provider: "openai", modelId: "gpt-5" });
		store.createChannel(agent.agentId, "napcat");
		store.addAdmin(agent.agentId, { channelType: "napcat", externalUserId: "42" });
		const reply = vi.fn(async () => []);
		const router = new CommandRouterService(store, () => ({ queued: 0, processing: false, currentJobId: undefined }));
		const plugin = {
			actions: { reply },
			groupTrigger: "all" as const,
		};

		await router.handleCommand(
			agent,
			plugin as never,
			{
				eventType: "message.created",
				channelType: "napcat",
				chatId: "777",
				chatKind: "group",
				messageId: "105",
				sender: { externalId: "42" },
				blocks: [{ kind: "text", text: "/trigger mention" }],
				occurredAt: "2026-03-29T00:00:00.000Z",
			},
			undefined,
		);

		expect(store.getNapcatChannelConfig(agent.agentId)?.groupTrigger).toBe("mention");
		expect(plugin.groupTrigger).toBe("mention");
		expect(reply.mock.calls.at(-1)?.[0]?.payload?.text).toContain("updated to mention");
	});

	it("accepts napcat group status commands from a mentioned message body", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { CommandRouterService } = await import("../src/runtime/command-router.js");
		const store = new JsonNekoclawStore();
		store.createAgent({ slug: "napcat-status-cat" });
		const agent = store.setBuiltinModelConfig("napcat-status-cat", { provider: "openai", modelId: "gpt-5" });
		store.createChannel(agent.agentId, "napcat");
		const session = store.createSession(agent.agentId, {
			channelType: "napcat",
			externalConversationId: "1063820039",
			chatKind: "group",
		});
		const reply = vi.fn(async () => []);
		const router = new CommandRouterService(store, () => ({ queued: 0, processing: false, currentJobId: undefined }));

		const handled = await router.handleCommand(
			agent,
			{
				actions: { reply },
			} as never,
			{
				eventType: "message.created",
				channelType: "napcat",
				chatId: "1063820039",
				chatKind: "group",
				messageId: "108",
				sender: { externalId: "123456789", displayName: "testuser" },
				mentionedUserIds: ["3794477609"],
				blocks: [{ kind: "text", text: "/status" }],
				occurredAt: "2026-03-29T00:00:00.000Z",
			},
			session,
		);

		expect(handled).toBe(true);
		expect(reply).toHaveBeenCalledTimes(1);
		expect(reply.mock.calls[0]?.[0]?.payload?.text).toContain(`Session key: ${session.sessionKey}`);
	});

	it("rejects trigger changes from non-admin users", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { CommandRouterService } = await import("../src/runtime/command-router.js");
		const store = new JsonNekoclawStore();
		store.createAgent({ slug: "locked-trigger-cat" });
		const agent = store.setBuiltinModelConfig("locked-trigger-cat", { provider: "openai", modelId: "gpt-5" });
		store.createChannel(agent.agentId, "telegram");
		const reply = vi.fn(async () => []);
		const router = new CommandRouterService(store, () => ({ queued: 0, processing: false, currentJobId: undefined }));

		await router.handleCommand(
			agent,
			{
				actions: { reply },
			} as never,
			{
				eventType: "message.created",
				channelType: "telegram",
				chatId: "-1009",
				chatKind: "group",
				messageId: "106",
				sender: { externalId: "9" },
				blocks: [{ kind: "text", text: "/trigger mention" }],
				occurredAt: "2026-03-29T00:00:00.000Z",
			},
			undefined,
		);

		expect(store.getTelegramChannelConfig(agent.agentId)?.groupTrigger).toBe("all");
		expect(reply.mock.calls.at(-1)?.[0]?.payload?.text).toContain("Only admins can use /trigger.");
	});
});
