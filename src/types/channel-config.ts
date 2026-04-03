import type { ChannelType, GroupTriggerMode, ReplyMode } from "./common.js";

export interface TelegramChannelConfig {
	token?: string;
	groupTrigger?: GroupTriggerMode;
	replyMode?: {
		dm?: ReplyMode;
		group?: ReplyMode;
	};
	addedAt: string;
	updatedAt: string;
}

export interface NapcatChannelConfig {
	wsUrl?: string;
	accessToken?: string;
	selfId?: string;
	groupTrigger?: GroupTriggerMode;
	replyMode?: {
		dm?: ReplyMode;
		group?: ReplyMode;
	};
	addedAt: string;
	updatedAt: string;
}

export interface ChannelSpec {
	agentId: string;
	type: ChannelType;
	createdAt: string;
	updatedAt: string;
}
