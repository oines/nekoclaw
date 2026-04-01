import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueueFullError } from "../src/runtime/errors.js";
import type { ChannelPlugin, InboundMessageEvent } from "../src/types.js";
import { getRuntimeKey } from "../src/runtime/runtime-key.js";

describe("message router", () => {
	let tempHome: string;
	const originalHome = process.env.HOME;

	beforeEach(() => {
		tempHome = mkdtempSync(join(tmpdir(), "nekoclaw-message-router-"));
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

	it("reads the latest agent model config for command handling without recreating the plugin", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { CommandRouterService } = await import("../src/runtime/command-router.js");
		const { MessageRouterService } = await import("../src/runtime/message-router.js");

		const store = new JsonNekoclawStore();
		store.createAgent({ slug: "reload-cat" });
		let agent = store.setBuiltinModelConfig("reload-cat", { provider: "openai", modelId: "gpt-5" });
		store.createChannel(agent.agentId, "telegram");
		store.setChannelToken(agent.agentId, "telegram", "token");
		store.createSession(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "-1001",
			chatKind: "group",
		});

		const reply = vi.fn(async () => []);
		const enqueue = vi.fn(async () => undefined);
		const plugin: ChannelPlugin = {
			type: "telegram",
			capabilities: {
				text: true,
				media: true,
				reply: true,
				edit: true,
				delete: true,
				typing: true,
			},
			outbound: {
				send: async () => [],
			},
			actions: {
				send: async () => [],
				reply,
				edit: async () => undefined,
				delete: async () => undefined,
				typing: async () => undefined,
			},
			threading: {
				resolveReplyMode: () => "off",
				applyReplyMode: (payload) => payload,
			},
			pairing: {
				shouldOfferPair: () => false,
				buildPairPrompt: () => ({}),
				buildPairAccepted: () => ({}),
				buildPairRejected: () => ({}),
			},
			triggering: {
				shouldProcessEvent: () => true,
			},
			resolveSessionAddress: () => ({
				channelType: "telegram",
				externalConversationId: "-1001",
				chatKind: "group",
			}),
			startPolling: () => undefined,
			stop: () => undefined,
		};
		const plugins = new Map<string, ChannelPlugin>();
		plugins.set(getRuntimeKey(agent.agentId, "telegram"), plugin);

		const commands = new CommandRouterService(store, () => ({ queued: 0, processing: false, currentJobId: undefined }));
		const router = new MessageRouterService(store, plugins, commands, enqueue);

		agent = store.setBuiltinModelConfig(agent.agentId, { provider: "openrouter", modelId: "z-ai/glm-4.7-flash" });

		const event: InboundMessageEvent = {
			eventType: "message.created",
			channelType: "telegram",
			chatId: "-1001",
			chatKind: "group",
			messageId: "12",
			sender: { externalId: "777" },
			blocks: [{ kind: "text", text: "/status@bot" }],
			occurredAt: "2026-03-29T00:00:00.000Z",
		};

		await router.handleInbound(agent.agentId, "telegram", event);

		expect(reply).toHaveBeenCalledTimes(1);
		expect(reply.mock.calls[0]?.[0]?.payload?.text).toContain("Effective model: openrouter/z-ai/glm-4.7-flash");
		expect(enqueue).not.toHaveBeenCalled();
	}, 10_000);

	it("replies with a busy message when enqueue is rejected", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { CommandRouterService } = await import("../src/runtime/command-router.js");
		const { MessageRouterService } = await import("../src/runtime/message-router.js");

		const store = new JsonNekoclawStore();
		const agent = store.createAgent({ slug: "busy-router-cat" });
		store.createChannel(agent.agentId, "telegram");
		store.setChannelToken(agent.agentId, "telegram", "token");
		const session = store.createSession(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "1001",
			chatKind: "dm",
		});

		const send = vi.fn(async () => []);
		const enqueue = vi.fn(async () => {
			throw new QueueFullError("Queue is full");
		});
		const plugin: ChannelPlugin = {
			type: "telegram",
			capabilities: {
				text: true,
				media: true,
				reply: true,
				edit: true,
				delete: true,
				typing: true,
			},
			outbound: {
				send: async () => [],
			},
			actions: {
				send,
				reply: async () => [],
				edit: async () => undefined,
				delete: async () => undefined,
				typing: async () => undefined,
			},
			threading: {
				resolveReplyMode: () => "off",
				applyReplyMode: (payload) => payload,
			},
			pairing: {
				shouldOfferPair: () => false,
				buildPairPrompt: () => ({}),
				buildPairAccepted: () => ({}),
				buildPairRejected: () => ({}),
			},
			triggering: {
				shouldProcessEvent: () => true,
			},
			resolveSessionAddress: () => ({
				channelType: "telegram",
				externalConversationId: "1001",
				chatKind: "dm",
			}),
			startPolling: () => undefined,
			stop: () => undefined,
		};
		const plugins = new Map<string, ChannelPlugin>();
		plugins.set(getRuntimeKey(agent.agentId, "telegram"), plugin);
		const commands = new CommandRouterService(store, () => ({ queued: 0, processing: false, currentJobId: undefined }));
		const router = new MessageRouterService(store, plugins, commands, enqueue);

		const event: InboundMessageEvent = {
			eventType: "message.created",
			channelType: "telegram",
			chatId: "1001",
			chatKind: "dm",
			messageId: "13",
			sender: { externalId: "8" },
			blocks: [{ kind: "text", text: "hello" }],
			occurredAt: "2026-03-29T00:00:00.000Z",
		};

		await router.handleInbound(agent.agentId, "telegram", event);

		expect(send).toHaveBeenCalledTimes(1);
		expect(send.mock.calls[0]?.[0]).toMatchObject({
			chatId: session.externalConversationId,
			payload: { text: "I'm busy right now. Please try again in a moment." },
		});
	});

	it("ignores paired group messages when the channel trigger does not match", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { CommandRouterService } = await import("../src/runtime/command-router.js");
		const { MessageRouterService } = await import("../src/runtime/message-router.js");

		const store = new JsonNekoclawStore();
		const agent = store.createAgent({ slug: "quiet-group-cat" });
		store.createChannel(agent.agentId, "telegram");
		store.setChannelToken(agent.agentId, "telegram", "token");
		store.createSession(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "-1002",
			chatKind: "group",
		});

		const enqueue = vi.fn(async () => undefined);
		const plugin: ChannelPlugin = {
			type: "telegram",
			capabilities: {
				text: true,
				media: true,
				reply: true,
				edit: true,
				delete: true,
				typing: true,
			},
			outbound: {
				send: async () => [],
			},
			actions: {
				send: async () => [],
				reply: async () => [],
				edit: async () => undefined,
				delete: async () => undefined,
				typing: async () => undefined,
			},
			threading: {
				resolveReplyMode: () => "off",
				applyReplyMode: (payload) => payload,
			},
			pairing: {
				shouldOfferPair: () => false,
				buildPairPrompt: () => ({}),
				buildPairAccepted: () => ({}),
				buildPairRejected: () => ({}),
			},
			triggering: {
				shouldProcessEvent: () => false,
			},
			resolveSessionAddress: () => ({
				channelType: "telegram",
				externalConversationId: "-1002",
				chatKind: "group",
			}),
			startPolling: () => undefined,
			stop: () => undefined,
		};
		const plugins = new Map<string, ChannelPlugin>();
		plugins.set(getRuntimeKey(agent.agentId, "telegram"), plugin);

		const commands = new CommandRouterService(store, () => ({ queued: 0, processing: false, currentJobId: undefined }));
		const router = new MessageRouterService(store, plugins, commands, enqueue);
		await router.handleInbound(agent.agentId, "telegram", {
			eventType: "message.created",
			channelType: "telegram",
			chatId: "-1002",
			chatKind: "group",
			messageId: "14",
			sender: { externalId: "88" },
			blocks: [{ kind: "text", text: "plain group text" }],
			occurredAt: "2026-03-29T00:00:00.000Z",
		});

		expect(enqueue).not.toHaveBeenCalled();
	});

	it("ignores group slash commands before command routing when mention triggering does not match", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { CommandRouterService } = await import("../src/runtime/command-router.js");
		const { MessageRouterService } = await import("../src/runtime/message-router.js");

		const store = new JsonNekoclawStore();
		store.createAgent({ slug: "quiet-command-cat" });
		let agent = store.setBuiltinModelConfig("quiet-command-cat", { provider: "openai", modelId: "gpt-5" });
		store.createChannel(agent.agentId, "napcat");
		store.createSession(agent.agentId, {
			channelType: "napcat",
			externalConversationId: "1063820039",
			chatKind: "group",
		});

		const reply = vi.fn(async () => []);
		const enqueue = vi.fn(async () => undefined);
		const plugin: ChannelPlugin = {
			type: "napcat",
			capabilities: {
				text: true,
				media: false,
				reply: true,
				edit: false,
				delete: true,
				typing: false,
			},
			outbound: {
				send: async () => [],
			},
			actions: {
				send: async () => [],
				reply,
				edit: async () => undefined,
				delete: async () => undefined,
				typing: async () => undefined,
			},
			threading: {
				resolveReplyMode: () => "off",
				applyReplyMode: (payload) => payload,
			},
			pairing: {
				shouldOfferPair: () => false,
				buildPairPrompt: () => ({}),
				buildPairAccepted: () => ({}),
				buildPairRejected: () => ({}),
			},
			triggering: {
				shouldProcessEvent: () => false,
			},
			resolveSessionAddress: () => ({
				channelType: "napcat",
				externalConversationId: "1063820039",
				chatKind: "group",
			}),
			startPolling: () => undefined,
			stop: () => undefined,
		};
		const plugins = new Map<string, ChannelPlugin>();
		plugins.set(getRuntimeKey(agent.agentId, "napcat"), plugin);
		const commands = new CommandRouterService(store, () => ({ queued: 0, processing: false, currentJobId: undefined }));
		const router = new MessageRouterService(store, plugins, commands, enqueue);

		await router.handleInbound(agent.agentId, "napcat", {
			eventType: "message.created",
			channelType: "napcat",
			chatId: "1063820039",
			chatKind: "group",
			messageId: "15",
			sender: { externalId: "3184675714" },
			blocks: [{ kind: "text", text: "/status" }],
			occurredAt: "2026-03-29T00:00:00.000Z",
		});

		expect(reply).not.toHaveBeenCalled();
		expect(enqueue).not.toHaveBeenCalled();
	});
});
