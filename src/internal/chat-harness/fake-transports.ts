import { InputFile } from "grammy";
import type { ChatKind } from "../../types.js";
import type { NapcatClientLike, NapcatMessageEvent } from "../../channels/napcat.js";
import type {
	TelegramBotLike,
	TelegramChat,
	TelegramDocument,
	TelegramMessage,
	TelegramPhotoSize,
	TelegramUser,
} from "../../channels/telegram.js";

export interface HarnessTranscriptEntry {
	channel: "telegram" | "napcat";
	kind: "inbound" | "outbound" | "edit" | "delete" | "typing" | "command";
	chatId: string;
	chatKind?: ChatKind;
	messageId?: string;
	replyToId?: string;
	text?: string;
	attachments?: Array<{
		kind: "image" | "file";
		name?: string;
		source?: string;
	}>;
	raw?: unknown;
}

function attachmentSource(value: string | InputFile): string {
	if (typeof value === "string") {
		return value;
	}
	const name = "filename" in value ? String((value as { filename?: unknown }).filename ?? "") : "";
	return name || "input-file";
}

export class FakeTelegramBot implements TelegramBotLike {
	readonly api: TelegramBotLike["api"];
	readonly transcript: HarnessTranscriptEntry[] = [];
	readonly commandScopes: Array<{
		commands: Array<{ command: string; description: string }>;
		scope: { scope: { type: "all_private_chats" | "all_group_chats" } };
	}> = [];

	private readonly messageHandlers: Array<(ctx: { message?: TelegramMessage; editedMessage?: TelegramMessage }) => Promise<void> | void> = [];
	private readonly errorHandlers: Array<(error: unknown) => void> = [];
	private readonly fileMap = new Map<string, { file_path?: string }>();
	private nextMessageId = 10_000;

	constructor(
		private readonly me: { id: number; username?: string } = { id: 9001, username: "mock_bot" },
	) {
		this.api = {
			getMe: async () => this.me,
			setMyCommands: async (commands, scope) => {
				this.commandScopes.push({ commands: [...commands], scope });
				this.transcript.push({
					channel: "telegram",
					kind: "command",
					chatId: "system",
					raw: { commands, scope },
				});
				return true;
			},
			sendMessage: async (chatId, text, options) => {
				const messageId = this.allocateMessageId();
				this.transcript.push({
					channel: "telegram",
					kind: "outbound",
					chatId,
					messageId: String(messageId),
					replyToId: options.reply_parameters ? String(options.reply_parameters.message_id) : undefined,
					text,
					raw: options,
				});
				return {
					chat: { id: chatId },
					message_id: messageId,
				};
			},
			sendPhoto: async (chatId, photo, options) => {
				const messageId = this.allocateMessageId();
				this.transcript.push({
					channel: "telegram",
					kind: "outbound",
					chatId,
					messageId: String(messageId),
					replyToId: options.reply_parameters ? String(options.reply_parameters.message_id) : undefined,
					text: options.caption,
					attachments: [{ kind: "image", source: attachmentSource(photo) }],
					raw: options,
				});
				return {
					chat: { id: chatId },
					message_id: messageId,
				};
			},
			sendDocument: async (chatId, document, options) => {
				const messageId = this.allocateMessageId();
				this.transcript.push({
					channel: "telegram",
					kind: "outbound",
					chatId,
					messageId: String(messageId),
					replyToId: options.reply_parameters ? String(options.reply_parameters.message_id) : undefined,
					text: options.caption,
					attachments: [{ kind: "file", source: attachmentSource(document) }],
					raw: options,
				});
				return {
					chat: { id: chatId },
					message_id: messageId,
				};
			},
			sendChatAction: async (chatId) => {
				this.transcript.push({
					channel: "telegram",
					kind: "typing",
					chatId,
				});
				return true;
			},
			editMessageText: async (chatId, messageId, text) => {
				this.transcript.push({
					channel: "telegram",
					kind: "edit",
					chatId,
					messageId: String(messageId),
					text,
				});
				return true;
			},
			deleteMessage: async (chatId, messageId) => {
				this.transcript.push({
					channel: "telegram",
					kind: "delete",
					chatId,
					messageId: String(messageId),
				});
				return true;
			},
			getFile: async (fileId) => this.fileMap.get(fileId) ?? {},
		};
	}

	catch(handler: (error: unknown) => void): void {
		this.errorHandlers.push(handler);
	}

	on(
		_filter: string | string[],
		handler: (ctx: { message?: TelegramMessage; editedMessage?: TelegramMessage }) => Promise<void> | void,
	): void {
		this.messageHandlers.push(handler);
	}

	async start(): Promise<void> {
		return undefined;
	}

	stop(): void {
		return undefined;
	}

	registerFile(fileId: string, file: { file_path?: string }): void {
		this.fileMap.set(fileId, file);
	}

	async emitInbound(message: TelegramMessage, eventType: "message.created" | "message.updated" = "message.created"): Promise<void> {
		this.transcript.push({
			channel: "telegram",
			kind: "inbound",
			chatId: String(message.chat.id),
			chatKind: message.chat.type === "private" ? "dm" : "group",
			messageId: String(message.message_id),
			replyToId: typeof message.reply_to_message?.message_id === "number" ? String(message.reply_to_message.message_id) : undefined,
			text: message.text ?? message.caption,
			raw: message,
		});
		const ctx = eventType === "message.updated" ? { editedMessage: message } : { message };
		for (const handler of this.messageHandlers) {
			await handler(ctx);
		}
	}

	emitError(error: unknown): void {
		for (const handler of this.errorHandlers) {
			handler(error);
		}
	}

	private allocateMessageId(): number {
		const current = this.nextMessageId;
		this.nextMessageId += 1;
		return current;
	}
}

function normalizeNapcatText(message: unknown): { text?: string; replyToId?: string; attachments?: HarnessTranscriptEntry["attachments"] } {
	if (typeof message === "string") {
		return { text: message };
	}
	if (!Array.isArray(message)) {
		return {};
	}
	const texts: string[] = [];
	const attachments: NonNullable<HarnessTranscriptEntry["attachments"]> = [];
	let replyToId: string | undefined;
	for (const segment of message as Array<{ type?: string; data?: Record<string, unknown> }>) {
		if (segment.type === "text") {
			const text = String(segment.data?.text ?? "").trim();
			if (text) {
				texts.push(text);
			}
			continue;
		}
		if (segment.type === "reply") {
			const id = segment.data?.id;
			replyToId = id === undefined ? undefined : String(id);
			continue;
		}
		if (segment.type === "image") {
			attachments.push({ kind: "image", source: typeof segment.data?.file === "string" ? segment.data.file : undefined });
			continue;
		}
		if (segment.type === "file") {
			attachments.push({
				kind: "file",
				source: typeof segment.data?.file === "string" ? segment.data.file : undefined,
				name: typeof segment.data?.name === "string" ? segment.data.name : undefined,
			});
		}
	}
	return {
		text: texts.length > 0 ? texts.join("\n") : undefined,
		replyToId,
		attachments: attachments.length > 0 ? attachments : undefined,
	};
}

function isUriLike(value: string | undefined): value is string {
	return typeof value === "string" && /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(value);
}

function isSupportedNapcatImageSource(value: string | undefined): boolean {
	return typeof value === "string" && (/^https?:\/\//i.test(value) || /^base64:\/\//i.test(value));
}

function assertSupportedNapcatOutgoingMessage(message: unknown): void {
	if (!Array.isArray(message)) {
		return;
	}
	for (const segment of message as Array<{ type?: string; data?: Record<string, unknown> }>) {
		const source = typeof segment.data?.file === "string" ? segment.data.file : undefined;
		if (segment.type === "image" && source && !isSupportedNapcatImageSource(source)) {
			throw new Error(`文件处理失败: 识别URL失败, uri= ${source}`);
		}
		if (segment.type === "file" && source && !isUriLike(source)) {
			throw new Error(`文件处理失败: 识别URL失败, uri= ${source}`);
		}
	}
}

export class FakeNapcatClient implements NapcatClientLike {
	readonly transcript: HarnessTranscriptEntry[] = [];

	connection: { readyState?: number } | undefined;

	private readonly handlers = new Map<string, Array<(value: unknown) => void>>();
	private readonly fileMap = new Map<string, { file: string; file_name: string; file_size: number; base64: string }>();
	private readonly downloadMap = new Map<string, { file: string }>();
	private nextMessageId = 20_000;

	on(event: string, handler: (value: unknown) => void): this {
		const handlers = this.handlers.get(event) ?? [];
		handlers.push(handler);
		this.handlers.set(event, handlers);
		return this;
	}

	async Start(): Promise<unknown> {
		this.connection = { readyState: 1 };
		return this;
	}

	Disconnect(): void {
		this.connection = undefined;
	}

	async CallApi(action: string, params: Record<string, unknown>): Promise<unknown> {
		if (action === "send_group_msg" || action === "send_private_msg") {
			assertSupportedNapcatOutgoingMessage(params.message);
			const parsed = normalizeNapcatText(params.message);
			const chatKind: ChatKind = action === "send_group_msg" ? "group" : "dm";
			const chatId = chatKind === "group" ? String(params.group_id) : String(params.user_id);
			const messageId = this.allocateMessageId();
			this.transcript.push({
				channel: "napcat",
				kind: "outbound",
				chatId,
				chatKind,
				messageId: String(messageId),
				replyToId: parsed.replyToId,
				text: parsed.text,
				attachments: parsed.attachments,
				raw: { action, params },
			});
			return messageId;
		}
		if (action === "delete_msg") {
			this.transcript.push({
				channel: "napcat",
				kind: "delete",
				chatId: "unknown",
				messageId: String(params.message_id ?? ""),
				raw: { action, params },
			});
			return true;
		}
		this.transcript.push({
			channel: "napcat",
			kind: "command",
			chatId: "system",
			raw: { action, params },
		});
		return true;
	}

	async GetFile(fileId: string): Promise<{ file: string; file_name: string; file_size: number; base64: string }> {
		return this.fileMap.get(fileId) ?? { file: "", file_name: "download.bin", file_size: 0, base64: "" };
	}

	async DownloadFile(url: string): Promise<{ file: string }> {
		return this.downloadMap.get(url) ?? { file: url };
	}

	registerFile(fileId: string, file: { file: string; file_name: string; file_size: number; base64: string }): void {
		this.fileMap.set(fileId, file);
	}

	registerDownload(url: string, file: { file: string }): void {
		this.downloadMap.set(url, file);
	}

	async emitInbound(eventName: string, event: NapcatMessageEvent): Promise<void> {
		this.transcript.push({
			channel: "napcat",
			kind: "inbound",
			chatId: event.message_type === "group" ? String(event.group_id) : String(event.user_id),
			chatKind: event.message_type === "group" ? "group" : "dm",
			messageId: String(event.message_id),
			text: typeof event.raw_message === "string" ? event.raw_message : undefined,
			raw: { eventName, event },
		});
		for (const handler of this.handlers.get(eventName) ?? []) {
			await handler(event);
		}
	}

	emitError(error: unknown): void {
		for (const handler of this.handlers.get("error") ?? []) {
			handler(error);
		}
	}

	private allocateMessageId(): number {
		const current = this.nextMessageId;
		this.nextMessageId += 1;
		return current;
	}
}

export interface TelegramMessageInput {
	chatId: number;
	chatType: TelegramChat["type"];
	messageId: number;
	mediaGroupId?: string;
	text?: string;
	caption?: string;
	from?: TelegramUser;
	replyToMessageId?: number;
	chatTitle?: string;
	photo?: TelegramPhotoSize[];
	document?: TelegramDocument;
	date?: number;
}

export function createTelegramMessage(input: TelegramMessageInput): TelegramMessage {
	return {
		message_id: input.messageId,
		date: input.date ?? Math.floor(Date.now() / 1_000),
		media_group_id: input.mediaGroupId,
		text: input.text,
		caption: input.caption,
		photo: input.photo,
		document: input.document,
		chat: {
			id: input.chatId,
			type: input.chatType,
			title: input.chatTitle,
		},
		from: input.from,
		reply_to_message:
			typeof input.replyToMessageId === "number"
				? {
						message_id: input.replyToMessageId,
					}
				: undefined,
	};
}
