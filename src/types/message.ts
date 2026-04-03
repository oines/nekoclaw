import type { ChannelType, ChatKind, MessageEventType } from "./common.js";
import type { SessionCronRecord } from "./session.js";

export interface AttachmentRef {
	kind: "image" | "file";
	name: string;
	relativePath: string;
	mimeType?: string;
	sizeBytes?: number;
}

export interface MessageSender {
	externalId?: string;
	displayName?: string;
}

export interface TextContentBlock {
	kind: "text";
	text: string;
}

export interface ImageContentBlock {
	kind: "image";
	remoteId?: string;
	name?: string;
	mimeType?: string;
	sizeBytes?: number;
	attachment?: AttachmentRef;
}

export interface FileContentBlock {
	kind: "file";
	remoteId?: string;
	name?: string;
	mimeType?: string;
	sizeBytes?: number;
	attachment?: AttachmentRef;
}

export type MessageContentBlock = TextContentBlock | ImageContentBlock | FileContentBlock;

export interface InboundMessageEvent {
	eventType: MessageEventType;
	channelType: ChannelType;
	chatId: string;
	chatKind: ChatKind;
	chatTitle?: string;
	messageId: string;
	replyToMessageId?: string;
	isReplyToBot?: boolean;
	mentionedUserIds?: string[];
	mentionedUsernames?: string[];
	sender: MessageSender;
	blocks: MessageContentBlock[];
	occurredAt: string;
}

export interface OutboundAttachment {
	kind: "image" | "file";
	filePath?: string;
	url?: string;
	name?: string;
	mimeType?: string;
}

export interface ReplyPayload {
	text?: string;
	attachments?: OutboundAttachment[];
	replyToId?: string;
	channelData?: Record<string, unknown>;
}

export type ChannelToolAction =
	| {
			kind: "send";
			payload: ReplyPayload;
	  }
	| {
			kind: "send_targeted";
			target: string;
			payload: ReplyPayload;
	  }
	| {
			kind: "reply";
			payload: ReplyPayload;
			replyToId?: string;
	  }
	| {
			kind: "edit";
			messageId: string;
			text: string;
	  }
	| {
			kind: "delete";
			messageId: string;
	  }
	| {
			kind: "typing";
	  }
	| {
			kind: "no_reply";
	  }
	| {
			kind: "cron_create";
			cronId: string;
			scheduleKind: SessionCronRecord["scheduleKind"];
			message: string;
			timezone?: string;
			runAtLocal?: string;
			hour?: number;
			minute?: number;
	  }
	| {
			kind: "cron_cancel";
			cronId: string;
	  };
