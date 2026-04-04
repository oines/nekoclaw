import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelegramChannelPlugin, mapTelegramMessageToEvent } from "../src/channels/telegram.js";
import type { ChannelSpec, InboundMessageEvent, SessionRecord } from "../src/types.js";

const channel: ChannelSpec = {
	agentId: "agent-1",
	type: "telegram",
	createdAt: "2026-03-29T00:00:00.000Z",
	updatedAt: "2026-03-29T00:00:00.000Z",
};

const dmSession: SessionRecord = {
	sessionRecordId: "chat-dm",
	agentId: "agent-1",
	channelType: "telegram",
	externalConversationId: "123",
	chatKind: "dm",
	sessionKey: "agent:cat-agent:telegram:direct:123",
	resetGeneration: 0,
	status: "active",
	createdAt: "2026-03-29T00:00:00.000Z",
	updatedAt: "2026-03-29T00:00:00.000Z",
};

const groupSession: SessionRecord = {
	...dmSession,
	sessionRecordId: "chat-group",
	externalConversationId: "-1001",
	chatKind: "group",
	sessionKey: "agent:cat-agent:telegram:group:-1001",
};

describe("telegram message mapping", () => {
	it("maps text, image, and reply metadata into a unified inbound event", () => {
		const event = mapTelegramMessageToEvent(
			{
				message_id: 42,
				date: 1711680000,
				caption: "hello from photo",
				photo: [{ file_id: "small" }, { file_id: "large", file_size: 2048 }],
				chat: { id: 123, type: "private" },
				from: {
					id: 999,
					first_name: "Alice",
					username: "alice",
				},
				reply_to_message: {
					message_id: 10,
				},
			},
			"message.created",
		);

		expect(event).toMatchObject({
			eventType: "message.created",
			channelType: "telegram",
			chatId: "123",
			chatKind: "dm",
			messageId: "42",
			replyToMessageId: "10",
			sender: {
				externalId: "999",
				displayName: "Alice (@alice)",
			},
		});
		expect(event?.blocks).toEqual([
			{ kind: "text", text: "hello from photo" },
			{
				kind: "image",
				remoteId: "large",
				name: "telegram-photo-42.jpg",
				mimeType: "image/jpeg",
				sizeBytes: 2048,
			},
		]);
	});

	it("maps documents into file blocks and edited messages into updates", () => {
		const event = mapTelegramMessageToEvent(
			{
				message_id: 77,
				date: 1711680000,
				text: "see attachment",
				document: {
					file_id: "doc-1",
					file_name: "spec.pdf",
					mime_type: "application/pdf",
					file_size: 1000,
				},
				chat: { id: -1001, type: "supergroup", title: "Ops" },
				from: { id: 55, first_name: "Bob" },
			},
			"message.updated",
		);

		expect(event).toMatchObject({
			eventType: "message.updated",
			chatId: "-1001",
			chatKind: "group",
			chatTitle: "Ops",
			messageId: "77",
		});
		expect(event?.blocks).toEqual([
			{ kind: "text", text: "see attachment" },
			{
				kind: "file",
				remoteId: "doc-1",
				name: "spec.pdf",
				mimeType: "application/pdf",
				sizeBytes: 1000,
			},
		]);
	});

	it("captures mentioned usernames for group trigger matching", () => {
		const event = mapTelegramMessageToEvent(
			{
				message_id: 88,
				text: "@mock_bot hello there",
				chat: { id: -1001, type: "supergroup", title: "Ops" },
			},
			"message.created",
		);

		expect(event?.mentionedUsernames).toEqual(["mock_bot"]);
	});
});

describe("telegram channel plugin outbound, reply mode, and hydration", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
		vi.restoreAllMocks();
	});

	it("sends direct messages without reply threading by default in DMs", async () => {
		const plugin = createTelegramChannelPlugin(channel, "token");
		const api = {
			setMyCommands: vi.fn().mockResolvedValue(true),
			sendMessage: vi.fn().mockResolvedValue({ chat: { id: 123 }, message_id: 1 }),
			sendPhoto: vi.fn(),
			sendDocument: vi.fn(),
			sendChatAction: vi.fn(),
			editMessageText: vi.fn(),
			deleteMessage: vi.fn(),
			getFile: vi.fn(),
		};
		(plugin as unknown as { bot: typeof api }).bot = {
			api,
			catch: vi.fn(),
			on: vi.fn(),
			start: vi.fn(),
			stop: vi.fn(),
		} as never;

		await plugin.outbound.send({
			session: dmSession,
			event: {
				eventType: "message.created",
				channelType: "telegram",
				chatId: "123",
				chatKind: "dm",
				messageId: "9",
				sender: {},
				blocks: [{ kind: "text", text: "hello" }],
				occurredAt: "2026-03-29T00:00:00.000Z",
			},
			payload: {
				text: "hello back",
			},
		});

		expect(api.sendMessage).toHaveBeenCalledWith("123", "hello back", {});
	});

	it("replies by default in groups and supports actions for media, typing, edit, and delete", async () => {
		const plugin = createTelegramChannelPlugin(channel, "token");
		const api = {
			setMyCommands: vi.fn().mockResolvedValue(true),
			sendMessage: vi.fn().mockResolvedValue({ chat: { id: -1001 }, message_id: 1 }),
			sendPhoto: vi.fn().mockResolvedValue({ chat: { id: -1001 }, message_id: 2 }),
			sendDocument: vi.fn().mockResolvedValue({ chat: { id: -1001 }, message_id: 3 }),
			sendChatAction: vi.fn().mockResolvedValue(undefined),
			editMessageText: vi.fn().mockResolvedValue(undefined),
			deleteMessage: vi.fn().mockResolvedValue(true),
			getFile: vi.fn(),
		};
		(plugin as unknown as { bot: typeof api }).bot = {
			api,
			catch: vi.fn(),
			on: vi.fn(),
			start: vi.fn(),
			stop: vi.fn(),
		} as never;

		await plugin.outbound.send({
			session: groupSession,
			event: {
				eventType: "message.created",
				channelType: "telegram",
				chatId: "-1001",
				chatKind: "group",
				messageId: "9",
				sender: {},
				blocks: [{ kind: "text", text: "hello group" }],
				occurredAt: "2026-03-29T00:00:00.000Z",
			},
			payload: {
				text: "reply in thread",
			},
		});

		await plugin.actions.reply({
			chatId: "-1001",
			replyToId: "11",
			payload: {
				text: "photo caption",
				attachments: [
					{
						kind: "image",
						url: "https://example.com/pic.jpg",
					},
				],
			},
		});
		await plugin.actions.send({
			chatId: "-1001",
			payload: {
				attachments: [
					{
						kind: "file",
						url: "https://example.com/spec.pdf",
						name: "spec.pdf",
					},
				],
			},
		});
		await plugin.actions.typing({ chatId: "-1001" });
		await plugin.actions.edit({ chatId: "-1001", messageId: "2", text: "edited" });
		await plugin.actions.delete({ chatId: "-1001", messageId: "2" });

		expect(api.sendMessage).toHaveBeenCalledWith("-1001", "reply in thread", {
			reply_parameters: { message_id: 9 },
		});
		expect(api.sendPhoto).toHaveBeenCalledWith(
			"-1001",
			"https://example.com/pic.jpg",
			expect.objectContaining({
				caption: "photo caption",
				reply_parameters: { message_id: 11 },
			}),
		);
		expect(api.sendDocument).toHaveBeenCalled();
		expect(api.sendChatAction).toHaveBeenCalledWith("-1001", "typing");
		expect(api.editMessageText).toHaveBeenCalledWith("-1001", 2, "edited");
		expect(api.deleteMessage).toHaveBeenCalledWith("-1001", 2);
	});

	it("downloads remote inbound media into the chat attachments directory", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "nekoclaw-telegram-"));
		const plugin = createTelegramChannelPlugin(channel, "token");
		const api = {
			setMyCommands: vi.fn().mockResolvedValue(true),
			getFile: vi.fn().mockResolvedValue({ file_path: "documents/report.pdf" }),
		};
		(plugin as unknown as { bot: typeof api }).bot = {
			api,
			catch: vi.fn(),
			on: vi.fn(),
			start: vi.fn(),
			stop: vi.fn(),
		} as never;
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
			}),
		);

		const hydrated = await plugin.hydrateInboundEvent?.(
			{
				eventType: "message.created",
				channelType: "telegram",
				chatId: "123",
				chatKind: "dm",
				messageId: "55",
				sender: {},
				blocks: [
					{
						kind: "file",
						remoteId: "file-1",
						name: "report.pdf",
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

		expect(api.getFile).toHaveBeenCalledWith("file-1");
		expect(hydrated?.blocks[0]).toMatchObject({
			kind: "file",
			attachment: {
				kind: "file",
				name: "report.pdf",
				relativePath: "chats/session-1/attachments/report.pdf",
				mimeType: "application/pdf",
			},
		});
		expect(readFileSync(join(tempDir, "report.pdf"))).toEqual(Buffer.from([1, 2, 3]));
	});

	it("hydrates inbound images with a workspace-relative attachment path", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "nekoclaw-telegram-"));
		const plugin = createTelegramChannelPlugin(channel, "token");
		const api = {
			setMyCommands: vi.fn().mockResolvedValue(true),
			getFile: vi.fn().mockResolvedValue({ file_path: "photos/pic.jpg" }),
		};
		(plugin as unknown as { bot: typeof api }).bot = {
			api,
			catch: vi.fn(),
			on: vi.fn(),
			start: vi.fn(),
			stop: vi.fn(),
		} as never;
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				arrayBuffer: async () => new Uint8Array([4, 5, 6]).buffer,
			}),
		);

		const hydrated = await plugin.hydrateInboundEvent?.(
			{
				eventType: "message.created",
				channelType: "telegram",
				chatId: "123",
				chatKind: "dm",
				messageId: "56",
				sender: {},
				blocks: [
					{
						kind: "image",
						remoteId: "photo-1",
						name: "photo.jpg",
						mimeType: "image/jpeg",
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
				name: "photo.jpg",
				relativePath: "chats/session-1/attachments/photo.jpg",
				mimeType: "image/jpeg",
			},
		});
		expect(readFileSync(join(tempDir, "photo.jpg"))).toEqual(Buffer.from([4, 5, 6]));
	});

	it("accepts /pair and /pair@botname for group pairing", () => {
		const plugin = createTelegramChannelPlugin(channel, "token");
		const plain = mapTelegramMessageToEvent(
			{
				message_id: 90,
				text: "/pair",
				chat: { id: -1001, type: "supergroup", title: "Ops" },
			},
			"message.created",
		);
		const addressed = mapTelegramMessageToEvent(
			{
				message_id: 91,
				text: "/pair@mock_bot",
				chat: { id: -1001, type: "supergroup", title: "Ops" },
			},
			"message.created",
		);
		const other = mapTelegramMessageToEvent(
			{
				message_id: 92,
				text: "/status@mock_bot",
				chat: { id: -1001, type: "supergroup", title: "Ops" },
			},
			"message.created",
		);

		expect(plugin.pairing.shouldOfferPair(plain!)).toBe(true);
		expect(plugin.pairing.shouldOfferPair(addressed!)).toBe(true);
		expect(plugin.pairing.shouldOfferPair(other!)).toBe(false);
	});

	it("supports mention-only group triggering", () => {
		const plugin = createTelegramChannelPlugin(channel, "token", undefined, "mention");
		(plugin as unknown as { botUsername?: string }).botUsername = "mock_bot";
		const plain = mapTelegramMessageToEvent(
			{
				message_id: 93,
				text: "hello group",
				chat: { id: -1001, type: "supergroup", title: "Ops" },
			},
			"message.created",
		);
		const addressed = mapTelegramMessageToEvent(
			{
				message_id: 94,
				text: "@mock_bot hello group",
				chat: { id: -1001, type: "supergroup", title: "Ops" },
			},
			"message.created",
		);

		expect(plugin.triggering.shouldProcessEvent(plain!)).toBe(false);
		expect(plugin.triggering.shouldProcessEvent(addressed!)).toBe(true);
	});

	it("only treats quoted group replies as addressed in mention mode when they reply to the bot", () => {
		const plugin = createTelegramChannelPlugin(channel, "token", undefined, "mention");
		(plugin as unknown as { botUsername?: string }).botUsername = "mock_bot";

		expect(
			plugin.triggering.shouldProcessEvent({
				eventType: "message.created",
				channelType: "telegram",
				chatId: "-1001",
				chatKind: "group",
				messageId: "95",
				replyToMessageId: "94",
				sender: { externalId: "42" },
				blocks: [{ kind: "text", text: "hello" }],
				occurredAt: "2026-03-29T00:00:00.000Z",
			}),
		).toBe(false);
		expect(
			plugin.triggering.shouldProcessEvent({
				eventType: "message.created",
				channelType: "telegram",
				chatId: "-1001",
				chatKind: "group",
				messageId: "95",
				replyToMessageId: "94",
				isReplyToBot: true,
				sender: { externalId: "42" },
				blocks: [{ kind: "text", text: "hello" }],
				occurredAt: "2026-03-29T00:00:00.000Z",
			}),
		).toBe(true);
	});

	it("marks inbound group replies as reply-to-bot only when the reply targets a bot-authored message id", async () => {
		const onHandler = vi.fn();
		const api = {
			getMe: vi.fn().mockResolvedValue({ id: 999, username: "mock_bot" }),
			setMyCommands: vi.fn().mockResolvedValue(true),
			sendMessage: vi.fn().mockResolvedValue({ chat: { id: -1001 }, message_id: 501 }),
			sendPhoto: vi.fn(),
			sendDocument: vi.fn(),
			sendChatAction: vi.fn(),
			editMessageText: vi.fn(),
			deleteMessage: vi.fn(),
			getFile: vi.fn(),
		};
		const plugin = createTelegramChannelPlugin(channel, "token", undefined, "mention", {
			bot: {
				api,
				catch: vi.fn(),
				on: onHandler,
				start: vi.fn().mockResolvedValue(undefined),
				stop: vi.fn(),
			} as never,
		});
		const events: InboundMessageEvent[] = [];

		plugin.startPolling({
			onEvent: async (event) => {
				events.push(event);
			},
			onError: vi.fn(),
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		await plugin.actions.send({
			chatId: "-1001",
			chatKind: "group",
			payload: { text: "bot says hi" },
		});

		const messageHandler = onHandler.mock.calls.find((call) => Array.isArray(call[0]) || call[0] === "message")?.[1];
		expect(typeof messageHandler).toBe("function");
		await messageHandler({
			message: {
				message_id: 600,
				text: "reply to bot",
				chat: { id: -1001, type: "supergroup", title: "Ops" },
				from: { id: 42, username: "alice" },
				reply_to_message: { message_id: 501 },
			},
		});
		await messageHandler({
			message: {
				message_id: 601,
				text: "reply to someone else",
				chat: { id: -1001, type: "supergroup", title: "Ops" },
				from: { id: 42, username: "alice" },
				reply_to_message: { message_id: 9999 },
			},
		});

		expect(events[0]?.replyToMessageId).toBe("501");
		expect(events[0]?.isReplyToBot).toBe(true);
		expect(events[1]?.replyToMessageId).toBe("9999");
		expect(events[1]?.isReplyToBot).toBe(false);
	});

	it("registers bot commands for private chats and groups when polling starts", async () => {
		const plugin = createTelegramChannelPlugin(channel, "token");
		const api = {
			getMe: vi.fn().mockResolvedValue({ username: "mock_bot" }),
			setMyCommands: vi.fn().mockResolvedValue(true),
			sendMessage: vi.fn(),
			sendPhoto: vi.fn(),
			sendDocument: vi.fn(),
			sendChatAction: vi.fn(),
			editMessageText: vi.fn(),
			deleteMessage: vi.fn(),
			getFile: vi.fn(),
		};
		const start = vi.fn().mockResolvedValue(undefined);
		(plugin as unknown as { bot: typeof api & { catch: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn>; start: typeof start; stop: ReturnType<typeof vi.fn> } }).bot = {
			api,
			catch: vi.fn(),
			on: vi.fn(),
			start,
			stop: vi.fn(),
		} as never;

		plugin.startPolling({
			onEvent: async () => undefined,
			onError: vi.fn(),
		});
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(api.setMyCommands).toHaveBeenCalledTimes(2);
		expect(api.getMe).toHaveBeenCalledTimes(1);
		expect(api.setMyCommands).toHaveBeenNthCalledWith(
			1,
			expect.arrayContaining([
				expect.objectContaining({ command: "help" }),
				expect.objectContaining({ command: "status" }),
				expect.objectContaining({ command: "pair" }),
				expect.objectContaining({ command: "stop" }),
				expect.objectContaining({ command: "reset" }),
				expect.objectContaining({ command: "model" }),
			]),
			{ scope: { type: "all_private_chats" } },
		);
		expect(api.setMyCommands).toHaveBeenNthCalledWith(
			2,
			expect.arrayContaining([
				expect.objectContaining({ command: "help" }),
				expect.objectContaining({ command: "pair" }),
				expect.objectContaining({ command: "status" }),
				expect.objectContaining({ command: "stop" }),
				expect.objectContaining({ command: "trigger" }),
				expect.objectContaining({ command: "reset" }),
				expect.objectContaining({ command: "model" }),
			]),
			{ scope: { type: "all_group_chats" } },
		);
		expect(start).toHaveBeenCalled();
	});
});
