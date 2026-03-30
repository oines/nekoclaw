import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelSpec, SessionRecord } from "../src/types.js";

const clientMocks = vi.hoisted(() => {
	const instances: FakeClient[] = [];

	class FakeClient {
		handlers = new Map<string, Array<(value: unknown) => void>>();
		connected = false;
		started = false;
		startCalls = 0;
		connection: { readyState: number } | undefined;
		callApi = vi.fn(async (action: string, params: Record<string, unknown>) => {
			if (action === "send_private_msg") {
				return 101;
			}
			if (action === "send_group_msg") {
				return 202;
			}
			return undefined;
		});
		getFile = vi.fn(async (_fileId: string) => ({
			file: "",
			file_name: "download.bin",
			file_size: 0,
			base64: "",
		}));
		downloadFile = vi.fn(async (url: string) => ({ file: url }));
		constructor(
			public readonly botUserId: number,
			public readonly config: Record<string, unknown>,
		) {
			instances.push(this);
		}
		on(event: string, handler: (value: unknown) => void): this {
			const existing = this.handlers.get(event) ?? [];
			existing.push(handler);
			this.handlers.set(event, existing);
			return this;
		}
		async Connect(): Promise<void> {
			this.connected = true;
			this.connection = { readyState: 1 };
		}
		async Start(): Promise<this> {
			this.startCalls += 1;
			this.started = true;
			this.connected = true;
			this.connection = { readyState: 1 };
			return this;
		}
		Disconnect(): void {
			this.connected = false;
			this.connection = undefined;
		}
		async CallApi(action: string, params: Record<string, unknown>): Promise<unknown> {
			return this.callApi(action, params);
		}
		async GetFile(fileId: string): Promise<{ file: string; file_name: string; file_size: number; base64: string }> {
			return this.getFile(fileId);
		}
		async DownloadFile(url: string, threadCount: number, headers: string[] | string, base64?: string): Promise<{ file: string }> {
			return this.downloadFile(url, threadCount, headers, base64);
		}
		emit(event: string, payload: unknown): void {
			for (const handler of this.handlers.get(event) ?? []) {
				handler(payload);
			}
		}
	}

	return {
		instances,
		FakeClient,
	};
});

vi.mock("onebot-client-next", () => ({
	Client: clientMocks.FakeClient,
	ELoggerLevel: {
		debug: 0,
		trace: 1,
		info: 2,
		warn: 3,
		error: 4,
	},
}));

const channel: ChannelSpec = {
	agentId: "agent-1",
	type: "napcat",
	createdAt: "2026-03-29T00:00:00.000Z",
	updatedAt: "2026-03-29T00:00:00.000Z",
};

const dmSession: SessionRecord = {
	sessionRecordId: "session-dm",
	agentId: "agent-1",
	channelType: "napcat",
	externalConversationId: "123456",
	chatKind: "dm",
	sessionKey: "agent:qq-cat:napcat:direct:123456",
	status: "active",
	createdAt: "2026-03-29T00:00:00.000Z",
	updatedAt: "2026-03-29T00:00:00.000Z",
};

describe("napcat channel plugin", () => {
	beforeEach(() => {
		clientMocks.instances.length = 0;
	});

	afterEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
	});

	it("maps private and group messages into nekoclaw events", async () => {
		const { mapNapcatMessageToEvent } = await import("../src/channels/napcat.js");
		const dm = mapNapcatMessageToEvent({
			post_type: "message",
			message_type: "private",
			sub_type: "friend",
			time: 1711680000,
			self_id: 999,
			user_id: 123456,
			message_id: 1,
			raw_message: "hello",
			message: [{ type: "text", data: { text: "hello" } }],
			sender: { user_id: 123456, nickname: "Alice" },
		});
		const group = mapNapcatMessageToEvent({
			post_type: "message",
			message_type: "group",
			sub_type: "normal",
			time: 1711680000,
			self_id: 999,
			user_id: 555,
			group_id: 777,
			message_id: 2,
			raw_message: "/pair",
			message: [{ type: "text", data: { text: "/pair" } }],
			sender: {
				user_id: 555,
				nickname: "Bob",
				card: "Builder",
				sex: "male",
				age: 20,
				area: "",
				level: "",
				role: "member",
				title: "",
			},
			anonymous: null,
		});

		expect(dm).toMatchObject({
			channelType: "napcat",
			chatKind: "dm",
			chatId: "123456",
			messageId: "1",
			sender: {
				externalId: "123456",
				displayName: "Alice",
			},
		});
		expect(group).toMatchObject({
			channelType: "napcat",
			chatKind: "group",
			chatId: "777",
			messageId: "2",
			sender: {
				externalId: "555",
				displayName: "Builder",
			},
		});
	});

	it("captures at-mentions for mention-only group triggering", async () => {
		const { mapNapcatMessageToEvent, createNapcatChannelPlugin } = await import("../src/channels/napcat.js");
		const event = mapNapcatMessageToEvent(
			{
				post_type: "message",
				message_type: "group",
				sub_type: "normal",
				time: 1711680000,
				self_id: 999,
				user_id: 555,
				group_id: 777,
				message_id: 9,
				raw_message: "@bot hello",
				message: [
					{ type: "at", data: { qq: "999" } },
					{ type: "text", data: { text: " hello" } },
				],
				sender: {
					user_id: 555,
					nickname: "Bob",
					card: "Builder",
					sex: "male",
					age: 20,
					area: "",
					level: "",
					role: "member",
					title: "",
				},
				anonymous: null,
			},
			"999",
		);
		const plugin = createNapcatChannelPlugin(
			channel,
			{
				wsUrl: "ws://127.0.0.1:3001",
				selfId: "999",
			},
			undefined,
			"mention",
		);

		expect(event?.mentionedUserIds).toEqual(["999"]);
		expect(plugin.triggering.shouldProcessEvent(event!)).toBe(true);
		expect(
			plugin.triggering.shouldProcessEvent({
				...event!,
				mentionedUserIds: [],
			}),
		).toBe(false);
	});

	it("treats quoted group replies as addressed when mention-only triggering is enabled", async () => {
		const { createNapcatChannelPlugin } = await import("../src/channels/napcat.js");
		const plugin = createNapcatChannelPlugin(
			channel,
			{
				wsUrl: "ws://127.0.0.1:3001",
				selfId: "999",
			},
			undefined,
			"mention",
		);

		expect(
			plugin.triggering.shouldProcessEvent({
				eventType: "message.created",
				channelType: "napcat",
				chatId: "777",
				chatKind: "group",
				messageId: "10",
				replyToMessageId: "9",
				sender: { externalId: "555" },
				blocks: [{ kind: "text", text: "hello" }],
				occurredAt: "2026-03-29T00:00:00.000Z",
			}),
		).toBe(true);
	});

	it("maps reply segments into replyToMessageId", async () => {
		const { mapNapcatMessageToEvent } = await import("../src/channels/napcat.js");
		const event = mapNapcatMessageToEvent({
			post_type: "message",
			message_type: "group",
			sub_type: "normal",
			time: 1711680000,
			self_id: 999,
			user_id: 555,
			group_id: 777,
			message_id: 10,
			raw_message: "[CQ:reply,id=9][CQ:at,qq=999] /status",
			message: [
				{ type: "reply", data: { id: "9" } },
				{ type: "at", data: { qq: "999" } },
				{ type: "text", data: { text: " /status" } },
			],
			sender: {
				user_id: 555,
				nickname: "Bob",
				card: "Builder",
				sex: "male",
				age: 20,
				area: "",
				level: "",
				role: "member",
				title: "",
			},
			anonymous: null,
		});

		expect(event?.replyToMessageId).toBe("9");
		expect(event?.blocks[0]).toEqual({ kind: "text", text: "/status" });
	});

	it("sends private and group replies through the OneBot client", async () => {
		const { createNapcatChannelPlugin } = await import("../src/channels/napcat.js");
		const plugin = createNapcatChannelPlugin(
			channel,
			{
				wsUrl: "ws://127.0.0.1:3001",
				accessToken: "token",
				selfId: "999",
			},
		);
		const client = clientMocks.instances[0];
		expect(client.config).toMatchObject({
			options: expect.objectContaining({
				log_level: 4,
				skip_logo: true,
			}),
		});

		const dmRefs = await plugin.outbound.send({
			session: dmSession,
			event: {
				eventType: "message.created",
				channelType: "napcat",
				chatId: "123456",
				chatKind: "dm",
				messageId: "10",
				sender: {},
				blocks: [{ kind: "text", text: "hello" }],
				occurredAt: "2026-03-29T00:00:00.000Z",
			},
			payload: {
				text: "pong",
			},
		});

		const groupRefs = await plugin.actions.reply({
			chatId: "777",
			chatKind: "group",
			replyToId: "10",
			payload: {
				text: "group pong",
			},
		});

		expect(client.connected).toBe(true);
		expect(client.started).toBe(true);
		expect(client.callApi).toHaveBeenNthCalledWith(
			1,
			"send_private_msg",
			expect.objectContaining({
				user_id: 123456,
			}),
		);
		expect(client.callApi).toHaveBeenNthCalledWith(
			2,
			"send_group_msg",
			expect.objectContaining({
				group_id: 777,
				message: expect.arrayContaining([
					expect.objectContaining({ type: "reply" }),
					expect.objectContaining({ type: "text" }),
				]),
			}),
		);
		expect(dmRefs[0]?.messageId).toBe("101");
		expect(groupRefs[0]?.messageId).toBe("202");
	});

	it("hydrates inbound image attachments from remote urls", async () => {
		const { createNapcatChannelPlugin } = await import("../src/channels/napcat.js");
		const plugin = createNapcatChannelPlugin(channel, {
			wsUrl: "ws://127.0.0.1:3001",
			accessToken: "token",
			selfId: "999",
		});
		const tempDir = mkdtempSync(join(tmpdir(), "nekoclaw-napcat-"));
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				arrayBuffer: async () => new Uint8Array([7, 8, 9]).buffer,
			}),
		);

		const hydrated = await plugin.hydrateInboundEvent?.(
			{
				eventType: "message.created",
				channelType: "napcat",
				chatId: "777",
				chatKind: "group",
				messageId: "12",
				sender: { externalId: "555" },
				blocks: [
					{
						kind: "image",
						remoteId: "https://example.com/image.png",
						name: "image.png",
						mimeType: "image/png",
					},
				],
				occurredAt: "2026-03-29T00:00:00.000Z",
			},
			{
				attachmentsDir: tempDir,
				attachmentsRelativeDir: "chats/session-1/attachments",
			},
		);

		expect(hydrated?.blocks[0]).toMatchObject({
			kind: "image",
			attachment: {
				kind: "image",
				name: "image.png",
				relativePath: "chats/session-1/attachments/image.png",
				mimeType: "image/png",
			},
		});
		expect(readFileSync(join(tempDir, "image.png"))).toEqual(Buffer.from([7, 8, 9]));
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("hydrates inbound file attachments via GetFile base64", async () => {
		const { createNapcatChannelPlugin } = await import("../src/channels/napcat.js");
		const plugin = createNapcatChannelPlugin(channel, {
			wsUrl: "ws://127.0.0.1:3001",
			accessToken: "token",
			selfId: "999",
		});
		const client = clientMocks.instances[0];
		client.getFile.mockResolvedValue({
			file: "",
			file_name: "spec.pdf",
			file_size: 3,
			base64: Buffer.from([1, 2, 3]).toString("base64"),
		});
		const tempDir = mkdtempSync(join(tmpdir(), "nekoclaw-napcat-"));

		const hydrated = await plugin.hydrateInboundEvent?.(
			{
				eventType: "message.created",
				channelType: "napcat",
				chatId: "777",
				chatKind: "group",
				messageId: "13",
				sender: { externalId: "555" },
				blocks: [
					{
						kind: "file",
						remoteId: "file-1",
						name: "spec.pdf",
						mimeType: "application/pdf",
					},
				],
				occurredAt: "2026-03-29T00:00:00.000Z",
			},
			{
				attachmentsDir: tempDir,
				attachmentsRelativeDir: "chats/session-1/attachments",
			},
		);

		expect(client.getFile).toHaveBeenCalledWith("file-1");
		expect(hydrated?.blocks[0]).toMatchObject({
			kind: "file",
			attachment: {
				kind: "file",
				name: "spec.pdf",
				relativePath: "chats/session-1/attachments/spec.pdf",
				mimeType: "application/pdf",
			},
		});
		expect(readFileSync(join(tempDir, "spec.pdf"))).toEqual(Buffer.from([1, 2, 3]));
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("sends image and file attachments through the OneBot client", async () => {
		const { createNapcatChannelPlugin } = await import("../src/channels/napcat.js");
		const plugin = createNapcatChannelPlugin(channel, {
			wsUrl: "ws://127.0.0.1:3001",
			accessToken: "token",
			selfId: "999",
		});
		const client = clientMocks.instances[0];
		const tempDir = mkdtempSync(join(tmpdir(), "nekoclaw-napcat-"));
		const imagePath = join(tempDir, "image.png");
		const filePath = join(tempDir, "spec.pdf");
		writeFileSync(imagePath, Buffer.from([1]));
		writeFileSync(filePath, Buffer.from([2]));

		await plugin.actions.send({
			chatId: "777",
			chatKind: "group",
			payload: {
				text: "see files",
				attachments: [
					{ kind: "image", filePath: imagePath, name: "image.png" },
					{ kind: "file", filePath: filePath, name: "spec.pdf" },
				],
			},
		});

		expect(client.callApi).toHaveBeenCalledTimes(2);
		expect(client.callApi).toHaveBeenNthCalledWith(
			1,
			"send_group_msg",
			expect.objectContaining({
				group_id: 777,
				message: expect.arrayContaining([
					expect.objectContaining({ type: "text" }),
					expect.objectContaining({ type: "image" }),
				]),
			}),
		);
		expect(client.callApi).toHaveBeenNthCalledWith(
			2,
			"send_group_msg",
			expect.objectContaining({
				group_id: 777,
				message: [expect.objectContaining({ type: "file" })],
			}),
		);
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("treats /pair in groups as a pairing trigger", async () => {
		const { createNapcatChannelPlugin } = await import("../src/channels/napcat.js");
		const plugin = createNapcatChannelPlugin(
			channel,
			{
				wsUrl: "ws://127.0.0.1:3001",
				selfId: "999",
			},
		);

		expect(
			plugin.pairing.shouldOfferPair({
				eventType: "message.created",
				channelType: "napcat",
				chatId: "777",
				chatKind: "group",
				messageId: "11",
				sender: {},
				blocks: [{ kind: "text", text: "/pair" }],
				occurredAt: "2026-03-29T00:00:00.000Z",
			}),
		).toBe(true);
	});

	it("listens to the OneBot subtyped message events", async () => {
		const { createNapcatChannelPlugin } = await import("../src/channels/napcat.js");
		const plugin = createNapcatChannelPlugin(channel, {
			wsUrl: "ws://127.0.0.1:3001",
			accessToken: "token",
			selfId: "999",
		});
		const client = clientMocks.instances[0];
		const events: Array<{ chatId: string; chatKind: "dm" | "group"; text: string }> = [];

		plugin.startPolling({
			onEvent: async (event) => {
				events.push({
					chatId: event.chatId,
					chatKind: event.chatKind,
					text: event.blocks[0]?.kind === "text" ? event.blocks[0].text : "",
				});
			},
		});

		client.emit("message.private.friend", {
			post_type: "message",
			message_type: "private",
			sub_type: "friend",
			time: 1711680000,
			self_id: 999,
			user_id: 123456,
			message_id: 3,
			raw_message: "hello dm",
			message: [{ type: "text", data: { text: "hello dm" } }],
			sender: { user_id: 123456, nickname: "Alice" },
		});
		client.emit("message.group.normal", {
			post_type: "message",
			message_type: "group",
			sub_type: "normal",
			time: 1711680000,
			self_id: 999,
			user_id: 555,
			group_id: 777,
			message_id: 4,
			raw_message: "hello group",
			message: [{ type: "text", data: { text: "hello group" } }],
			sender: {
				user_id: 555,
				nickname: "Bob",
				card: "Builder",
				sex: "male",
				age: 20,
				area: "",
				level: "",
				role: "member",
				title: "",
			},
			anonymous: null,
		});

		await Promise.resolve();

		expect(events).toEqual([
			{ chatId: "123456", chatKind: "dm", text: "hello dm" },
			{ chatId: "777", chatKind: "group", text: "hello group" },
		]);
	});

	it("reuses the existing client connection for multiple sends", async () => {
		const { createNapcatChannelPlugin } = await import("../src/channels/napcat.js");
		const plugin = createNapcatChannelPlugin(channel, {
			wsUrl: "ws://127.0.0.1:3001",
			accessToken: "token",
			selfId: "999",
		});
		const client = clientMocks.instances[0];

		await plugin.actions.send({
			chatId: "123456",
			chatKind: "dm",
			payload: { text: "first" },
		});
		await plugin.actions.send({
			chatId: "123456",
			chatKind: "dm",
			payload: { text: "second" },
		});

		expect(client.startCalls).toBe(1);
	});

	it("does not reconnect just because the sdk emitted a non-fatal error event", async () => {
		const { createNapcatChannelPlugin } = await import("../src/channels/napcat.js");
		const plugin = createNapcatChannelPlugin(channel, {
			wsUrl: "ws://127.0.0.1:3001",
			accessToken: "token",
			selfId: "999",
		});
		const client = clientMocks.instances[0];
		const errors: string[] = [];

		plugin.startPolling({
			onEvent: async () => undefined,
			onError: (error) => {
				errors.push(error.message);
			},
		});
		client.emit("error", { message: "temporary issue" });

		await plugin.actions.send({
			chatId: "123456",
			chatKind: "dm",
			payload: { text: "after error" },
		});

		expect(errors).toEqual(["temporary issue"]);
		expect(client.startCalls).toBe(1);
	});
});
