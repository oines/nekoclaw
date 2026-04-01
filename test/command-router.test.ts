import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("runtime command router", () => {
	let tempHome: string;
	const originalHome = process.env.HOME;

	beforeEach(() => {
		tempHome = mkdtempSync(join(tmpdir(), "nekoclaw-command-router-"));
		process.env.HOME = tempHome;
		vi.resetModules();
	});

	afterEach(() => {
		vi.restoreAllMocks();
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
		const store = new JsonNekoclawStore();
		store.createAgent({ slug: "status-cat" });
		const agent = store.setBuiltinModelConfig("status-cat", { provider: "openai", modelId: "gpt-5" });
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
				blocks: [{ kind: "text", text: "/status" }],
				occurredAt: "2026-03-29T00:00:00.000Z",
			},
			session,
		);

		expect(handled).toBe(true);
		expect(reply).toHaveBeenCalledTimes(1);
		expect(reply.mock.calls[0]?.[0]?.payload?.text).toContain("Platform user id: 777");
		expect(reply.mock.calls[0]?.[0]?.payload?.text).toContain("Channel trigger: all");
		expect(reply.mock.calls[0]?.[0]?.payload?.text).toContain("Channel trigger: all");
		expect(reply.mock.calls[0]?.[0]?.payload?.text).toContain(`Session key: ${session.sessionKey}`);
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
		expect(text).toContain("/trigger mention - Trigger only on mentions for this channel");
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
