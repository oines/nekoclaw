import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelSpec, InboundMessageEvent, SessionRecord } from "../src/types.js";

const clientMocks = vi.hoisted(() => {
	const instances: FakeClient[] = [];

	class FakeClient {
		handlers = new Map<string, Array<(value: unknown) => void>>();
		connected = false;
		started = false;
		startCalls = 0;
		startFailures: Error[] = [];
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
				const failure = this.startFailures.shift();
				if (failure) {
					this.connected = false;
					this.connection = undefined;
					throw failure;
				}
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

async function createTestPlugin(options?: {
	config?: Partial<{ wsUrl: string; accessToken?: string; selfId: string }>;
	groupTrigger?: "all" | "mention";
	sendDelayMs?: () => number;
}) {
	const { createNapcatChannelPlugin } = await import("../src/channels/napcat.js");
	return createNapcatChannelPlugin(
		channel,
		{
			wsUrl: "ws://127.0.0.1:3001",
			accessToken: "token",
			selfId: "999",
			...options?.config,
		},
		undefined,
		options?.groupTrigger,
		{
			sendDelayMs: options?.sendDelayMs ?? (() => 0),
		},
	);
}

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
			const { mapNapcatMessageToEvent } = await import("../src/channels/napcat.js");
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
			const plugin = await createTestPlugin({
				config: { accessToken: undefined },
				groupTrigger: "mention",
			});

		expect(event?.mentionedUserIds).toEqual(["999"]);
		expect(plugin.triggering.shouldProcessEvent(event!)).toBe(true);
		expect(
			plugin.triggering.shouldProcessEvent({
				...event!,
				mentionedUserIds: [],
			}),
		).toBe(false);
	});

		it("only treats quoted group replies as addressed when they reply to the bot in mention-only mode", async () => {
			const plugin = await createTestPlugin({
				config: { accessToken: undefined },
				groupTrigger: "mention",
			});

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
			).toBe(false);
			expect(
				plugin.triggering.shouldProcessEvent({
					eventType: "message.created",
					channelType: "napcat",
					chatId: "777",
					chatKind: "group",
					messageId: "10",
					replyToMessageId: "9",
					isReplyToBot: true,
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

	it("marks inbound group replies as reply-to-bot only when the reply targets a bot-authored message id", async () => {
		const plugin = await createTestPlugin({
			config: { accessToken: undefined },
			groupTrigger: "mention",
			sendDelayMs: () => 0,
		});
		const client = clientMocks.instances[0];
		const events: InboundMessageEvent[] = [];

		plugin.startPolling({
			onEvent: async (event) => {
				events.push(event);
			},
		});
		await plugin.actions.send({
			chatId: "777",
			chatKind: "group",
			payload: { text: "bot says hi" },
		});

		client.emit("message.group.normal", {
			post_type: "message",
			message_type: "group",
			sub_type: "normal",
			time: 1711680000,
			self_id: 999,
			user_id: 555,
			group_id: 777,
			message_id: 30,
			raw_message: "[CQ:reply,id=202] hello back",
			message: [
				{ type: "reply", data: { id: "202" } },
				{ type: "text", data: { text: "hello back" } },
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
		client.emit("message.group.normal", {
			post_type: "message",
			message_type: "group",
			sub_type: "normal",
			time: 1711680001,
			self_id: 999,
			user_id: 555,
			group_id: 777,
			message_id: 31,
			raw_message: "[CQ:reply,id=9999] hello other",
			message: [
				{ type: "reply", data: { id: "9999" } },
				{ type: "text", data: { text: "hello other" } },
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

		await Promise.resolve();

		expect(events[0]?.replyToMessageId).toBe("202");
		expect(events[0]?.isReplyToBot).toBe(true);
		expect(events[1]?.replyToMessageId).toBe("9999");
		expect(events[1]?.isReplyToBot).toBe(false);
	});

		it("sends private and group replies through the OneBot client", async () => {
			const plugin = await createTestPlugin();
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
			const plugin = await createTestPlugin();
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
			const plugin = await createTestPlugin();
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
			const plugin = await createTestPlugin();
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
			const plugin = await createTestPlugin({
				config: { accessToken: undefined },
			});

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
			const plugin = await createTestPlugin();
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
			const plugin = await createTestPlugin();
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

		it("delays plain sends by 1-3 seconds before calling the NapCat API", async () => {
			vi.useFakeTimers();
			const plugin = await createTestPlugin({
				sendDelayMs: () => 1_500,
			});
			const client = clientMocks.instances[0];

			const sendPromise = plugin.actions.send({
				chatId: "123456",
				chatKind: "dm",
				payload: { text: "delayed hello" },
			});
			await Promise.resolve();

			expect(client.callApi).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1_499);
			expect(client.callApi).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			await expect(sendPromise).resolves.toEqual([
				{
					chatId: "123456",
					messageId: "101",
				},
			]);
			expect(client.callApi).toHaveBeenCalledTimes(1);
		});

		it("delays replies before sending them", async () => {
			vi.useFakeTimers();
			const plugin = await createTestPlugin({
				sendDelayMs: () => 3_000,
			});
			const client = clientMocks.instances[0];

			const replyPromise = plugin.actions.reply({
				chatId: "777",
				chatKind: "group",
				replyToId: "10",
				payload: { text: "delayed reply" },
			});
			await Promise.resolve();

			await vi.advanceTimersByTimeAsync(2_999);
			expect(client.callApi).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			await expect(replyPromise).resolves.toEqual([
				{
					chatId: "777",
					messageId: "202",
				},
			]);
			expect(client.callApi).toHaveBeenCalledTimes(1);
		});

		it("cancels a delayed send if the plugin stops before the wait ends", async () => {
			vi.useFakeTimers();
			const plugin = await createTestPlugin({
				sendDelayMs: () => 2_000,
			});
			const client = clientMocks.instances[0];

			const sendPromise = plugin.actions.send({
				chatId: "123456",
				chatKind: "dm",
				payload: { text: "will cancel" },
			}).catch((error: unknown) => error);
			await Promise.resolve();

			await vi.advanceTimersByTimeAsync(1_000);
			plugin.startPolling({ onEvent: async () => undefined });
			plugin.stop();
			await vi.advanceTimersByTimeAsync(1_000);

			const error = await sendPromise;
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toBe("NapCat send cancelled because the plugin stopped");
			expect(client.callApi).not.toHaveBeenCalled();
		});

		it("does not reconnect just because the sdk emitted a non-fatal error event", async () => {
			const plugin = await createTestPlugin();
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

		it("reconnects with backoff after the connection closes and reports recovery", async () => {
			vi.useFakeTimers();
			const plugin = await createTestPlugin();
		const client = clientMocks.instances[0];
		const healthy = vi.fn();
		const errors: string[] = [];

		plugin.startPolling({
			onEvent: async () => undefined,
			onError: (error) => {
				errors.push(error.message);
			},
			onHealthy: healthy,
		});
		await Promise.resolve();
		await Promise.resolve();

		client.connection = undefined;
		client.emit("close", { code: 1006 });
		expect(client.startCalls).toBe(1);
		expect(healthy).toHaveBeenCalledTimes(0);

		await vi.advanceTimersByTimeAsync(999);
		expect(client.startCalls).toBe(1);
		await vi.advanceTimersByTimeAsync(1);

		expect(client.startCalls).toBe(2);
		expect(healthy).toHaveBeenCalledTimes(1);
		expect(errors).toEqual([expect.stringContaining("connection lost")]);
	});

		it("keeps retrying failed reconnects with backoff and can recover on a later attempt", async () => {
			vi.useFakeTimers();
			const plugin = await createTestPlugin();
		const client = clientMocks.instances[0];
		const healthy = vi.fn();
		const errors: string[] = [];

		plugin.startPolling({
			onEvent: async () => undefined,
			onError: (error) => {
				errors.push(error.message);
			},
			onHealthy: healthy,
		});
		await Promise.resolve();
		await Promise.resolve();
		client.startFailures.push(new Error("first reconnect failed"), new Error("second reconnect failed"));

		client.connection = undefined;
		client.emit("disconnect", {});

		await vi.advanceTimersByTimeAsync(1_000);
		expect(client.startCalls).toBe(2);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(client.startCalls).toBe(3);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(client.startCalls).toBe(4);

		expect(errors).toEqual([
			expect.stringContaining("connection lost"),
			"first reconnect failed",
			"second reconnect failed",
		]);
		expect(healthy).toHaveBeenCalledTimes(1);
	});

		it("cancels pending reconnect attempts when stopped", async () => {
			vi.useFakeTimers();
			const plugin = await createTestPlugin();
		const client = clientMocks.instances[0];

		plugin.startPolling({
			onEvent: async () => undefined,
		});
		await Promise.resolve();
		await Promise.resolve();

		client.connection = undefined;
		client.emit("close", { code: 1006 });
		plugin.stop();
		await vi.advanceTimersByTimeAsync(30_000);

		expect(client.startCalls).toBe(1);
	});
});
