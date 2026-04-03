import type { ChannelType, ChatKind } from "./common.js";

export interface SessionModelOverride {
	provider: string;
	modelId: string;
	updatedAt: string;
}

export interface SessionLastRoute {
	channelType: ChannelType;
	externalConversationId: string;
	threadId?: string;
	updatedAt: string;
}

export interface SessionConfig {
	externalConversationId: string;
	channelType: ChannelType;
	chatKind: ChatKind;
	chatTitle?: string;
	sessionKey: string;
	parentSessionKey?: string;
	threadId?: string;
	lastRoute?: SessionLastRoute;
	modelOverride?: SessionModelOverride;
	resetGeneration: number;
	status: "active" | "removed";
	pairedAt: string;
	updatedAt: string;
}

export interface SessionRecord {
	sessionRecordId: string;
	agentId: string;
	sessionKey: string;
	parentSessionKey?: string;
	channelType: ChannelType;
	externalConversationId: string;
	threadId?: string;
	chatKind: ChatKind;
	chatTitle?: string;
	lastRoute?: SessionLastRoute;
	modelOverride?: SessionModelOverride;
	resetGeneration: number;
	status: "active" | "removed";
	createdAt: string;
	updatedAt: string;
}

export interface SessionCronRecord {
	cronId: string;
	agentId: string;
	sessionRecordId: string;
	sessionKey: string;
	channelType: ChannelType;
	chatKind: ChatKind;
	externalConversationId: string;
	threadId?: string;
	chatTitle?: string;
	status: "active" | "canceled" | "invalidated" | "completed";
	scheduleKind: "once" | "daily";
	message: string;
	timezone: string;
	runAtLocal?: string;
	hour?: number;
	minute?: number;
	nextRunAt: string;
	lastTriggeredAt?: string;
	createdAt: string;
	updatedAt: string;
	createdFromResetGeneration: number;
}

export interface ChannelSessionAddress {
	channelType: ChannelType;
	externalConversationId: string;
	chatKind: ChatKind;
	threadId?: string;
	parentSessionKey?: string;
}
