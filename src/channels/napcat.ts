import { existsSync } from "node:fs";
import { Client, ELoggerLevel, type MessageEvent, type Segment, type TElements } from "onebot-client-next";
import { isExplicitlyAddressedEvent } from "../command-parsing.js";
import { downloadBinary, persistAttachment, readLocalBinary } from "../media.js";
import type {
	ChannelCapabilities,
	ChannelHydrateEventInput,
	ChannelMessageRef,
	ChannelPlugin,
	ChannelPollCallbacks,
	ChannelReplyInput,
	ChannelSendInput,
	ChannelSpec,
	ChatKind,
	FileContentBlock,
	GroupTriggerMode,
	ImageContentBlock,
	InboundMessageEvent,
	MessageContentBlock,
	ReplyMode,
	ReplyPayload,
} from "../types.js";

export type NapcatMessageEvent = MessageEvent.TPrivateMessageEvent | MessageEvent.TGroupMessageEvent;
type FileSegmentLike = {
	type: string;
	data?: Record<string, unknown>;
};
type NapcatMessageEventName =
	| "message.private.friend"
	| "message.private.group"
	| "message.group.normal"
	| "message.group.notice";

export interface NapcatClientLike {
	on(event: string, handler: (value: unknown) => void): this;
	Start(): Promise<unknown>;
	Disconnect(): void;
	CallApi(action: string, params: Record<string, unknown>): Promise<unknown>;
	GetFile(fileId: string): Promise<{ file: string; file_name: string; file_size: number; base64: string }>;
	DownloadFile(url: string, threadCount: number, headers: string[] | string, base64?: string): Promise<{ file: string }>;
	connection?: { readyState?: number };
}

const NAPCAT_MESSAGE_EVENTS: NapcatMessageEventName[] = [
	"message.private.friend",
	"message.private.group",
	"message.group.normal",
	"message.group.notice",
];
const WS_OPEN = 1;
const NAPCAT_DOWNLOAD_THREAD_COUNT = 2;
const DEFAULT_GROUP_TRIGGER: GroupTriggerMode = "all";

function isFileSegment(segment: Segment.TSegment): segment is Segment.TSegment & FileSegmentLike {
	return (segment as FileSegmentLike).type === "file";
}

import {
	createOutboundAdapter,
	createPairingAdapter,
	createThreadingAdapter,
} from "./base-channel.js";


function normalizeSegments(message: TElements): Segment.TSegment[] {
	if (typeof message === "string") {
		return message.trim() ? [{ type: "text", data: { text: message } }] : [];
	}
	if (Array.isArray(message)) {
		return message;
	}
	return [message];
}

function buildMessageMetadata(message: NapcatMessageEvent): {
	blocks: MessageContentBlock[];
	mentionedUserIds?: string[];
	replyToMessageId?: string;
} {
	const blocks: MessageContentBlock[] = [];
	const texts: string[] = [];
	const mentionedUserIds = new Set<string>();
	let replyToMessageId: string | undefined;
	for (const segment of normalizeSegments(message.message)) {
		if (segment.type === "text") {
			const text = String(segment.data.text ?? "").trim();
			if (text) {
				texts.push(text);
			}
			continue;
		}
		if (segment.type === "image") {
			const block: ImageContentBlock = {
				kind: "image",
				remoteId: typeof segment.data.url === "string" ? segment.data.url : String(segment.data.file ?? ""),
				name: `napcat-image-${message.message_id}.jpg`,
			};
			blocks.push(block);
			continue;
		}
		if (segment.type === "at") {
			const qq = segment.data.qq;
			if (typeof qq === "number" || typeof qq === "string") {
				mentionedUserIds.add(String(qq));
			}
			continue;
		}
		if (segment.type === "reply") {
			const replyId = segment.data.id;
			if (typeof replyId === "number" || typeof replyId === "string") {
				replyToMessageId = String(replyId);
			}
			continue;
		}
		if (isFileSegment(segment)) {
			const block: FileContentBlock = {
				kind: "file",
				remoteId: String(segment.data?.file ?? ""),
				name:
					typeof segment.data?.name === "string"
						? segment.data.name
						: `napcat-file-${message.message_id}`,
			};
			blocks.push(block);
		}
	}
	if (texts.length > 0) {
		blocks.unshift({
			kind: "text",
			text: texts.join("\n"),
		});
	}
	return {
		blocks,
		mentionedUserIds: mentionedUserIds.size > 0 ? Array.from(mentionedUserIds) : undefined,
		replyToMessageId,
	};
}

function getSenderName(message: NapcatMessageEvent): string | undefined {
	if (message.message_type === "group") {
		return message.sender.card || message.sender.nickname || String(message.user_id);
	}
	return message.sender.nickname || String(message.user_id);
}

export function mapNapcatMessageToEvent(
	message: NapcatMessageEvent,
	selfId?: string,
): InboundMessageEvent | undefined {
	if (selfId && String(message.user_id) === selfId) {
		return undefined;
	}
	const { blocks, mentionedUserIds, replyToMessageId } = buildMessageMetadata(message);
	if (blocks.length === 0 && !message.raw_message.trim()) {
		return undefined;
	}
	if (blocks.length === 0) {
		blocks.push({
			kind: "text",
			text: message.raw_message.trim(),
		});
	}
	const isGroupMessage = message.message_type === "group";
	const chatKind: ChatKind = isGroupMessage ? "group" : "dm";
	const chatId = isGroupMessage ? String(message.group_id) : String(message.user_id);
	return {
		eventType: "message.created",
		channelType: "napcat",
		chatId,
		chatKind,
		messageId: String(message.message_id),
		replyToMessageId,
		mentionedUserIds,
		sender: {
			externalId: String(message.user_id),
			displayName: getSenderName(message),
		},
		blocks,
		occurredAt: new Date(message.time * 1_000).toISOString(),
	};
}

function toTextElements(text: string, replyToId?: string): TElements {
	const segments: Segment.TSegment[] = [];
	if (replyToId) {
		segments.push({
			type: "reply",
			data: { id: replyToId },
		});
	}
	segments.push({
		type: "text",
		data: { text },
	});
	return segments;
}

function toAttachmentElements(
	attachment: NonNullable<ReplyPayload["attachments"]>[number],
	text?: string,
	replyToId?: string,
): TElements {
	const segments: Segment.TSegment[] = [];
	if (replyToId) {
		segments.push({
			type: "reply",
			data: { id: replyToId },
		});
	}
	if (text?.trim()) {
		segments.push({
			type: "text",
			data: { text },
		});
	}
	const source = attachment.filePath ?? attachment.url;
	if (!source) {
		throw new Error("Outbound media requires either filePath or url");
	}
	segments.push(
		attachment.kind === "image"
			? {
					type: "image",
					data: { file: source },
				}
			: ({
					type: "file",
					data: {
						file: source,
						name: attachment.name ?? "attachment",
					},
				} as unknown as Segment.TSegment),
	);
	return segments;
}

function decodeBase64(base64: string): Uint8Array {
	return new Uint8Array(Buffer.from(base64, "base64"));
}

function isHttpUrl(value: string | undefined): value is string {
	if (!value) {
		return false;
	}
	return /^https?:\/\//i.test(value);
}

function isAccessibleLocalPath(path: string | undefined): path is string {
	if (!path) {
		return false;
	}
	return !/^https?:\/\//i.test(path) && existsSync(path);
}

export class NapcatChannelPlugin implements ChannelPlugin {
	readonly type = "napcat" as const;
	readonly capabilities: ChannelCapabilities = {
		text: true,
		media: true,
		reply: true,
		edit: false,
		delete: true,
		typing: false,
	};

	readonly actions = {
		send: async (input: ChannelSendInput): Promise<ChannelMessageRef[]> =>
			this.sendPayload(input.chatId, input.chatKind ?? "dm", input.payload),
		reply: async (input: ChannelReplyInput): Promise<ChannelMessageRef[]> =>
			this.sendPayload(input.chatId, input.chatKind ?? "dm", input.payload, input.replyToId),
		edit: async (): Promise<void> => {
			throw new Error("NapCat does not support editing messages in this plugin");
		},
		delete: async (input: { messageId: string }): Promise<void> => {
			await this.client.CallApi("delete_msg", {
				message_id: Number.parseInt(input.messageId, 10),
			});
		},
		typing: async (): Promise<void> => undefined,
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
			if (!isExplicitlyAddressedEvent(event)) {
				return false;
			}
			return event.mentionedUserIds?.includes(this.selfId) ?? false;
		},
	};

	readonly botIdentity: { username?: string; userId: string };

	private running = false;
	private connectPromise: Promise<void> | undefined;
	private readonly client: NapcatClientLike;

	constructor(
		private readonly channel: ChannelSpec,
		options: {
			wsUrl: string;
			accessToken?: string;
			selfId: string;
		},
		replyModes?: Partial<Record<ChatKind, ReplyMode>>,
		private readonly groupTrigger: GroupTriggerMode = DEFAULT_GROUP_TRIGGER,
		runtime?: { client?: NapcatClientLike },
	) {
		this.replyModes = replyModes ?? {};
		this.client = runtime?.client ??
			(new Client(Number.parseInt(options.selfId, 10), {
				websocket_address: options.wsUrl,
				accent_token: options.accessToken,
				options: {
					log_level: ELoggerLevel.error,
					skip_logo: true,
				},
			}) as unknown as NapcatClientLike);
		this.selfId = options.selfId;
		this.botIdentity = { userId: options.selfId };
		this.threading = createThreadingAdapter(this.replyModes);
		this.outbound = createOutboundAdapter(this.capabilities, this.actions, this.threading);
	}

	private readonly replyModes: Partial<Record<ChatKind, ReplyMode>>;
	private readonly selfId: string;

	resolveSessionAddress(event: InboundMessageEvent) {
		return {
			channelType: "napcat" as const,
			externalConversationId: event.chatId,
			chatKind: event.chatKind,
		};
	}

	startPolling(callbacks: ChannelPollCallbacks): void {
		if (this.running) {
			return;
		}
		this.running = true;
		for (const eventName of NAPCAT_MESSAGE_EVENTS) {
			this.client.on(eventName, async (message) => {
				const event = mapNapcatMessageToEvent(message as NapcatMessageEvent, this.selfId);
				if (event) {
					await callbacks.onEvent(event);
				}
			});
		}
		this.client.on("error", (event) => {
			callbacks.onError?.(this.toError(event));
		});
		void this.ensureConnected().catch((error) => {
			this.running = false;
			callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
		});
	}

	stop(): void {
		if (!this.running) {
			return;
		}
		this.running = false;
		this.connectPromise = undefined;
		this.client.Disconnect();
	}

	async hydrateInboundEvent(event: InboundMessageEvent, input: ChannelHydrateEventInput): Promise<InboundMessageEvent> {
		await this.ensureConnected();
		const blocks = await Promise.all(
			event.blocks.map(async (block, index) => {
				if ((block.kind !== "image" && block.kind !== "file") || !block.remoteId || block.attachment) {
					return block;
				}
				const bytes = block.kind === "image"
					? await this.downloadImage(block.remoteId)
					: await this.downloadFile(block.remoteId);
				if (!bytes) {
					return block;
				}
				return {
					...block,
					attachment: persistAttachment({
						attachmentsDir: input.attachmentsDir,
						attachmentsRelativeDir: input.attachmentsRelativeDir,
						bytes: bytes.data,
						kind: block.kind,
						fallbackBaseName: `${event.messageId}-${index}`,
						name: bytes.name ?? block.name,
						mimeType: bytes.mimeType ?? block.mimeType,
						sizeBytes: bytes.sizeBytes ?? block.sizeBytes,
					}),
				};
			}),
		);
		return {
			...event,
			blocks,
		};
	}

	private async ensureConnected(): Promise<void> {
		if (this.isConnectionOpen()) {
			return;
		}
		if (this.connectPromise) {
			return this.connectPromise;
		}
		if (this.client.connection && this.client.connection.readyState !== WS_OPEN) {
			this.client.Disconnect();
		}
		this.connectPromise = this.client.Start().then(() => undefined).finally(() => {
			this.connectPromise = undefined;
		});
		return this.connectPromise;
	}

	private isConnectionOpen(): boolean {
		return this.client.connection?.readyState === WS_OPEN;
	}

	private toError(event: unknown): Error {
		if (event instanceof Error) {
			return event;
		}
		if (typeof event === "object" && event !== null) {
			const candidate = event as { error?: unknown; message?: unknown };
			if (candidate.error instanceof Error) {
				return candidate.error;
			}
			if (typeof candidate.message === "string" && candidate.message.trim()) {
				return new Error(candidate.message);
			}
			if (candidate.error !== undefined) {
				return new Error(String(candidate.error));
			}
		}
		return new Error(String(event));
	}

	private async downloadImage(remoteId: string): Promise<{
		data: Uint8Array;
		name?: string;
		mimeType?: string;
		sizeBytes?: number;
	} | undefined> {
		if (isHttpUrl(remoteId)) {
			const data = await downloadBinary(remoteId);
			return { data, sizeBytes: data.byteLength };
		}
		if (typeof remoteId === "string" && isAccessibleLocalPath(remoteId)) {
			const localPath = remoteId;
			const data = readLocalBinary(localPath);
			return {
				data,
				name: String(localPath).split("/").at(-1),
				sizeBytes: data.byteLength,
			};
		}
		return undefined;
	}

	private async downloadFile(remoteId: string): Promise<{
		data: Uint8Array;
		name?: string;
		mimeType?: string;
		sizeBytes?: number;
	} | undefined> {
		if (isHttpUrl(remoteId)) {
			const data = await downloadBinary(remoteId);
			return { data, sizeBytes: data.byteLength };
		}
		const fileInfo = await this.client.GetFile(remoteId);
		if (fileInfo.base64) {
			const data = decodeBase64(fileInfo.base64);
			return {
				data,
				name: fileInfo.file_name,
				sizeBytes: fileInfo.file_size,
			};
		}
		if (isAccessibleLocalPath(fileInfo.file)) {
			const data = readLocalBinary(fileInfo.file);
			return {
				data,
				name: fileInfo.file_name,
				sizeBytes: fileInfo.file_size || data.byteLength,
			};
		}
		if (isHttpUrl(fileInfo.file)) {
			const download = await this.client.DownloadFile(fileInfo.file, NAPCAT_DOWNLOAD_THREAD_COUNT, []);
			if (isAccessibleLocalPath(download.file)) {
				const data = readLocalBinary(download.file);
				return {
					data,
					name: fileInfo.file_name,
					sizeBytes: fileInfo.file_size || data.byteLength,
				};
			}
		}
		return undefined;
	}

	private async sendPayload(
		chatId: string,
		chatKind: ChatKind,
		payload: ReplyPayload,
		replyToId?: string,
	): Promise<ChannelMessageRef[]> {
		await this.ensureConnected();
		if (payload.attachments?.length) {
			const refs: ChannelMessageRef[] = [];
			let first = true;
			for (const attachment of payload.attachments) {
				const messageId = await this.sendMessage(
					chatId,
					chatKind,
					toAttachmentElements(attachment, first ? payload.text : undefined, first ? replyToId : undefined),
				);
				refs.push({
					chatId,
					messageId: String(messageId),
				});
				first = false;
			}
			return refs;
		}
		if (!payload.text?.trim()) {
			return [];
		}
		const messageId = await this.sendMessage(chatId, chatKind, toTextElements(payload.text, replyToId));
		return [
			{
				chatId,
				messageId: String(messageId),
			},
		];
	}

	private async sendMessage(chatId: string, chatKind: ChatKind, message: TElements): Promise<unknown> {
		return chatKind === "group"
			? this.client.CallApi("send_group_msg", {
					group_id: Number.parseInt(chatId, 10),
					message,
				})
			: this.client.CallApi("send_private_msg", {
					user_id: Number.parseInt(chatId, 10),
					message,
				});
	}
}

export function createNapcatChannelPlugin(
	channel: ChannelSpec,
	options: {
		wsUrl: string;
		accessToken?: string;
		selfId: string;
	},
	replyModes?: Partial<Record<ChatKind, ReplyMode>>,
	groupTrigger?: GroupTriggerMode,
	runtime?: { client?: NapcatClientLike },
): NapcatChannelPlugin {
	return new NapcatChannelPlugin(channel, options, replyModes, groupTrigger, runtime);
}
