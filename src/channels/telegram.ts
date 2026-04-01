import { join } from "node:path";
import { Bot, GrammyError, HttpError, InputFile } from "grammy";
import { isExplicitlyAddressedEvent } from "../command-parsing.js";
import { getEventText } from "../messages.js";
import { downloadBinary, persistAttachment } from "../media.js";
import type {
	ChannelBotIdentity,
	ChannelCapabilities,
	ChannelHydrateEventInput,
	ChannelMessageRef,
	ChannelPlugin,
	ChannelPollCallbacks,
	ChannelReplyInput,
	ChannelSendInput,
	ChannelSpec,
	ChatKind,
	GroupTriggerMode,
	InboundMessageEvent,
	MessageContentBlock,
	ReplyMode,
	ReplyPayload,
} from "../types.js";

export interface TelegramUser {
	id: number;
	username?: string;
	first_name?: string;
	last_name?: string;
}

export interface TelegramChat {
	id: number;
	type: "private" | "group" | "supergroup" | "channel";
	title?: string;
}

export interface TelegramPhotoSize {
	file_id: string;
	file_size?: number;
}

export interface TelegramDocument {
	file_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

export interface TelegramMessage {
	message_id: number;
	date?: number;
	media_group_id?: string;
	text?: string;
	caption?: string;
	photo?: TelegramPhotoSize[];
	document?: TelegramDocument;
	chat: TelegramChat;
	from?: TelegramUser;
	reply_to_message?: {
		message_id?: number;
	};
}

export interface TelegramBotLike {
	api: {
		getMe(): Promise<{ id: number; username?: string }>;
		setMyCommands(
			commands: Array<{ command: string; description: string }>,
			scope: { scope: { type: "all_private_chats" | "all_group_chats" } },
		): Promise<unknown>;
		sendMessage(
			chatId: string,
			text: string,
			options: { reply_parameters?: { message_id: number } },
		): Promise<{ chat: { id: number | string }; message_id: number | string }>;
		sendPhoto(
			chatId: string,
			photo: string | InputFile,
			options: { caption?: string; reply_parameters?: { message_id: number } },
		): Promise<{ chat: { id: number | string }; message_id: number | string }>;
		sendDocument(
			chatId: string,
			document: string | InputFile,
			options: { caption?: string; reply_parameters?: { message_id: number } },
		): Promise<{ chat: { id: number | string }; message_id: number | string }>;
		sendChatAction(chatId: string, action: "typing"): Promise<unknown>;
		editMessageText(chatId: string, messageId: number, text: string): Promise<unknown>;
		deleteMessage(chatId: string, messageId: number): Promise<unknown>;
		getFile(fileId: string): Promise<{ file_path?: string }>;
	};
	catch(handler: (error: unknown) => void): void;
	on(
		filter: string | string[],
		handler: (ctx: { message?: TelegramMessage; editedMessage?: TelegramMessage }) => Promise<void> | void,
	): void;
	start(options: { allowed_updates: string[]; drop_pending_updates: boolean }): Promise<void>;
	stop(): void;
}

import {
	createOutboundAdapter,
	createPairingAdapter,
	createThreadingAdapter,
} from "./base-channel.js";
const DEFAULT_GROUP_TRIGGER: GroupTriggerMode = "all";

const TELEGRAM_DM_COMMANDS = [
	{ command: "help", description: "Show available chat commands" },
	{ command: "status", description: "Show session status and your platform user id" },
	{ command: "pair", description: "Start pairing this chat with an agent" },
	{ command: "reset", description: "Reset the current session (admin only)" },
	{ command: "model", description: "Change the session or agent model (admin only)" },
] as const;

const TELEGRAM_GROUP_COMMANDS = [
	{ command: "help", description: "Show available chat commands" },
	{ command: "pair", description: "Pair this group with the agent" },
	{ command: "status", description: "Show session status in this chat" },
	{ command: "trigger", description: "Change group trigger mode (admin only)" },
	{ command: "reset", description: "Reset the current session (admin only)" },
	{ command: "model", description: "Change the session or agent model (admin only)" },
] as const;

function getSenderName(user?: TelegramUser): string | undefined {
	if (!user) {
		return undefined;
	}
	const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
	return user.username ? `${fullName || user.username} (@${user.username})` : fullName || String(user.id);
}



function extractMentionedUsernames(text: string): string[] | undefined {
	const matches = Array.from(text.matchAll(/@([a-zA-Z0-9_]+)/g), (match) => match[1]?.toLowerCase()).filter(Boolean);
	return matches.length > 0 ? Array.from(new Set(matches)) : undefined;
}

function buildReplyParameters(replyToId?: string): { reply_parameters?: { message_id: number } } {
	if (!replyToId) {
		return {};
	}
	const parsed = Number.parseInt(replyToId, 10);
	if (!Number.isFinite(parsed)) {
		return {};
	}
	return {
		reply_parameters: {
			message_id: parsed,
		},
	};
}

function buildBlocks(message: TelegramMessage): MessageContentBlock[] {
	const blocks: MessageContentBlock[] = [];
	const text = (message.text ?? message.caption ?? "").trim();
	if (text) {
		blocks.push({
			kind: "text",
			text,
		});
	}

	const bestPhoto = message.photo?.at(-1);
	if (bestPhoto) {
		blocks.push({
			kind: "image",
			remoteId: bestPhoto.file_id,
			name: `telegram-photo-${message.message_id}.jpg`,
			mimeType: "image/jpeg",
			sizeBytes: bestPhoto.file_size,
		});
	}

	if (message.document) {
		blocks.push({
			kind: "file",
			remoteId: message.document.file_id,
			name: message.document.file_name,
			mimeType: message.document.mime_type,
			sizeBytes: message.document.file_size,
		});
	}

	return blocks;
}

export function mapTelegramMessageToEvent(
	message: TelegramMessage,
	eventType: InboundMessageEvent["eventType"],
): InboundMessageEvent | undefined {
	const blocks = buildBlocks(message);
	if (blocks.length === 0) {
		return undefined;
	}

	return {
		eventType,
		channelType: "telegram",
		chatId: String(message.chat.id),
		chatKind: message.chat.type === "private" ? "dm" : "group",
		chatTitle: message.chat.title,
		messageId: String(message.message_id),
		replyToMessageId:
			typeof message.reply_to_message?.message_id === "number"
				? String(message.reply_to_message.message_id)
				: undefined,
		mentionedUsernames: extractMentionedUsernames([message.text ?? "", message.caption ?? ""].join("\n")),
		sender: {
			externalId: message.from ? String(message.from.id) : undefined,
			displayName: getSenderName(message.from),
		},
		blocks,
		occurredAt: new Date((message.date ?? Math.floor(Date.now() / 1_000)) * 1_000).toISOString(),
	};
}

export function mapTelegramMediaGroupToEvent(
	messages: TelegramMessage[],
	eventType: InboundMessageEvent["eventType"],
): InboundMessageEvent | undefined {
	if (messages.length === 0) {
		return undefined;
	}
	const sorted = [...messages].sort((left, right) => left.message_id - right.message_id);
	const primary = sorted[0];
	const replyToMessage = sorted.find((message) => message.reply_to_message?.message_id !== undefined)?.reply_to_message;
	const text = sorted
		.map((message) => (message.text ?? message.caption ?? "").trim())
		.filter(Boolean)
		.join("\n")
		.trim();
	const blocks = sorted.flatMap((message) => buildBlocks(message));
	if (blocks.length === 0) {
		return undefined;
	}
	return {
		eventType,
		channelType: "telegram",
		chatId: String(primary.chat.id),
		chatKind: primary.chat.type === "private" ? "dm" : "group",
		chatTitle: primary.chat.title,
		messageId: String(primary.message_id),
		replyToMessageId: typeof replyToMessage?.message_id === "number" ? String(replyToMessage.message_id) : undefined,
		mentionedUsernames: extractMentionedUsernames(text),
		sender: {
			externalId: primary.from ? String(primary.from.id) : undefined,
			displayName: getSenderName(primary.from),
		},
		blocks,
		occurredAt: new Date((primary.date ?? Math.floor(Date.now() / 1_000)) * 1_000).toISOString(),
	};
}

export class TelegramChannelPlugin implements ChannelPlugin {
	readonly type = "telegram" as const;
	readonly capabilities: ChannelCapabilities = {
		text: true,
		media: true,
		reply: true,
		edit: true,
		delete: true,
		typing: true,
	};

	readonly actions = {
		send: async (input: ChannelSendInput): Promise<ChannelMessageRef[]> =>
			this.sendPayload(input.chatId, input.payload),
		reply: async (input: ChannelReplyInput): Promise<ChannelMessageRef[]> =>
			this.sendPayload(input.chatId, input.payload, input.replyToId),
		edit: async (input: { chatId: string; messageId: string; text: string }): Promise<void> => {
			await this.bot.api.editMessageText(input.chatId, Number.parseInt(input.messageId, 10), input.text);
		},
		delete: async (input: { chatId: string; messageId: string }): Promise<void> => {
			await this.bot.api.deleteMessage(input.chatId, Number.parseInt(input.messageId, 10));
		},
		typing: async (input: { chatId: string }): Promise<void> => {
			await this.bot.api.sendChatAction(input.chatId, "typing");
		},
	};

	readonly threading: ReturnType<typeof createThreadingAdapter>;
	readonly outbound: ReturnType<typeof createOutboundAdapter>;
	readonly pairing = createPairingAdapter();

	readonly triggering = {
		shouldProcessEvent: (event: InboundMessageEvent): boolean => {
			if (event.chatKind === "dm") {
				return true;
			}
			if (this.groupTrigger === "all") {
				return true;
			}
			if (event.replyToMessageId) {
				return true;
			}
			if (!this.botUsername) {
				return false;
			}
			if (!isExplicitlyAddressedEvent(event)) {
				return false;
			}
			return event.mentionedUsernames?.includes(this.botUsername.toLowerCase()) ?? false;
		},
	};

	resolveSessionAddress(event: InboundMessageEvent) {
		return {
			channelType: "telegram" as const,
			externalConversationId: event.chatId,
			chatKind: event.chatKind,
		};
	}

	botIdentity?: ChannelBotIdentity;

	private readonly bot: TelegramBotLike;
	private running = false;
	private handlersRegistered = false;
	private commandsRegistered = false;
	private botUsername?: string;
	private readonly mediaGroupBuffers = new Map<
		string,
		{
			eventType: InboundMessageEvent["eventType"];
			messages: TelegramMessage[];
			timer?: ReturnType<typeof setTimeout>;
		}
	>();

	constructor(
		private readonly channel: ChannelSpec,
		private readonly token: string,
		replyModes?: Partial<Record<ChatKind, ReplyMode>>,
		private readonly groupTrigger: GroupTriggerMode = DEFAULT_GROUP_TRIGGER,
		options?: { bot?: TelegramBotLike },
	) {
		this.bot = options?.bot ?? (new Bot(token) as unknown as TelegramBotLike);
		this.replyModes = replyModes ?? {};
		this.threading = createThreadingAdapter(this.replyModes);
		this.outbound = createOutboundAdapter(this.capabilities, this.actions, this.threading);
	}

	private readonly replyModes: Partial<Record<ChatKind, ReplyMode>>;

	private ensureHandlers(callbacks: ChannelPollCallbacks): void {
		if (this.handlersRegistered) {
			return;
		}
		this.handlersRegistered = true;
		this.bot.catch((error) => {
			if (error instanceof GrammyError || error instanceof HttpError) {
				callbacks.onError?.(new Error(error.message));
				return;
			}
			const wrapped = error as { error?: unknown };
			callbacks.onError?.(wrapped.error instanceof Error ? wrapped.error : new Error(String(wrapped.error)));
		});
		this.bot.on(["message", "edited_message"], async (ctx) => {
			const message = (ctx.editedMessage ?? ctx.message) as TelegramMessage | undefined;
			if (!message) {
				return;
			}
			const eventType = ctx.editedMessage ? "message.updated" : "message.created";
			if (message.media_group_id) {
				this.queueMediaGroupMessage(message, eventType, callbacks);
				return;
			}
			const event = mapTelegramMessageToEvent(message, eventType);
			if (!event) {
				return;
			}
			await callbacks.onEvent(event);
		});
	}

	private queueMediaGroupMessage(
		message: TelegramMessage,
		eventType: InboundMessageEvent["eventType"],
		callbacks: ChannelPollCallbacks,
	): void {
		const key = `${message.chat.id}:${message.media_group_id}`;
		const pending = this.mediaGroupBuffers.get(key) ?? {
			eventType,
			messages: [],
		};
		pending.eventType = eventType === "message.updated" ? "message.updated" : pending.eventType;
		pending.messages.push(message);
		if (pending.timer) {
			clearTimeout(pending.timer);
		}
		pending.timer = setTimeout(() => {
			void this.flushMediaGroup(key, callbacks);
		}, 75);
		this.mediaGroupBuffers.set(key, pending);
	}

	private async flushMediaGroup(key: string, callbacks: ChannelPollCallbacks): Promise<void> {
		const pending = this.mediaGroupBuffers.get(key);
		if (!pending) {
			return;
		}
		this.mediaGroupBuffers.delete(key);
		const event = mapTelegramMediaGroupToEvent(pending.messages, pending.eventType);
		if (!event) {
			return;
		}
		await callbacks.onEvent(event);
	}

	startPolling(callbacks: ChannelPollCallbacks): void {
		if (this.running) {
			return;
		}
		this.running = true;
		this.ensureHandlers(callbacks);
		void this.initializeBotMetadata(callbacks)
			.then(async () => {
				if (!this.commandsRegistered) {
					this.commandsRegistered = true;
					await this.registerCommands();
				}
				await this.bot.start({
					allowed_updates: ["message", "edited_message"],
					drop_pending_updates: false,
				});
			})
			.catch((error) => {
				this.running = false;
				this.commandsRegistered = false;
				callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
			});
	}

	stop(): void {
		if (!this.running) {
			return;
		}
		for (const pending of this.mediaGroupBuffers.values()) {
			if (pending.timer) {
				clearTimeout(pending.timer);
			}
		}
		this.mediaGroupBuffers.clear();
		this.running = false;
		this.bot.stop();
	}

	private async registerCommands(): Promise<void> {
		await this.bot.api.setMyCommands([...TELEGRAM_DM_COMMANDS], {
			scope: {
				type: "all_private_chats",
			},
		});
		await this.bot.api.setMyCommands([...TELEGRAM_GROUP_COMMANDS], {
			scope: {
				type: "all_group_chats",
			},
		});
	}

	private async initializeBotMetadata(callbacks: ChannelPollCallbacks): Promise<void> {
		if (this.botUsername) {
			return;
		}
		const me = await this.bot.api.getMe();
		this.botUsername = me.username ?? undefined;
		this.botIdentity = {
			username: this.botUsername,
			userId: String(me.id),
		};
		if (!this.botUsername) {
			callbacks.onError?.(new Error("Telegram bot username is unavailable"));
		}
	}

	async hydrateInboundEvent(event: InboundMessageEvent, input: ChannelHydrateEventInput): Promise<InboundMessageEvent> {
		const blocks = await Promise.all(
			event.blocks.map(async (block, index) => {
				if ((block.kind !== "image" && block.kind !== "file") || !block.remoteId || block.attachment) {
					return block;
				}

				const file = await this.bot.api.getFile(block.remoteId);
				if (!file.file_path) {
					return block;
				}

				const bytes = await downloadBinary(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`);
				return {
					...block,
					attachment: persistAttachment({
						attachmentsDir: input.attachmentsDir,
						attachmentsRelativeDir: input.attachmentsRelativeDir,
						bytes,
						kind: block.kind,
						fallbackBaseName: `${event.messageId}-${index}`,
						name: block.name,
						mimeType: block.mimeType,
						sizeBytes: block.sizeBytes,
					}),
				};
			}),
		);
		return {
			...event,
			blocks,
		};
	}

	private async sendPayload(chatId: string, payload: ReplyPayload, replyToId?: string): Promise<ChannelMessageRef[]> {
		const refs: ChannelMessageRef[] = [];
		if (payload.attachments?.length) {
			let first = true;
			for (const attachment of payload.attachments) {
				const ref = await this.sendAttachment(chatId, attachment, first ? payload.text : undefined, first ? replyToId : undefined);
				refs.push(ref);
				first = false;
			}
			return refs;
		}

		if (!payload.text?.trim()) {
			return refs;
		}

		const message = await this.bot.api.sendMessage(chatId, payload.text, {
			...buildReplyParameters(replyToId),
		});
		refs.push({
			chatId: String(message.chat.id),
			messageId: String(message.message_id),
		});
		return refs;
	}

	private async sendAttachment(
		chatId: string,
		attachment: NonNullable<ReplyPayload["attachments"]>[number],
		text?: string,
		replyToId?: string,
	): Promise<ChannelMessageRef> {
		const mediaInput = attachment.filePath ? new InputFile(attachment.filePath, attachment.name) : attachment.url;
		if (!mediaInput) {
			throw new Error("Outbound media requires either filePath or url");
		}

		if (attachment.kind === "image") {
			const message = await this.bot.api.sendPhoto(chatId, mediaInput, {
				caption: text,
				...buildReplyParameters(replyToId),
			});
			return {
				chatId: String(message.chat.id),
				messageId: String(message.message_id),
			};
		}

		const message = await this.bot.api.sendDocument(chatId, mediaInput, {
			caption: text,
			...buildReplyParameters(replyToId),
		});
		return {
			chatId: String(message.chat.id),
			messageId: String(message.message_id),
		};
	}
}

export function createTelegramChannelPlugin(
	channel: ChannelSpec,
	token: string,
	replyModes?: Partial<Record<ChatKind, ReplyMode>>,
	groupTrigger?: GroupTriggerMode,
	options?: { bot?: TelegramBotLike },
): TelegramChannelPlugin {
	return new TelegramChannelPlugin(channel, token, replyModes, groupTrigger, options);
}
