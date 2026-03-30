import type { ChannelSessionAddress, ChatKind, ChannelType } from "../types.js";

function normalizeAgentSlug(agentSlug: string): string {
	return agentSlug.trim().toLowerCase();
}

function normalizeConversationId(value: string): string {
	return value.trim();
}

function normalizeThreadId(value: string): string {
	return value.trim().toLowerCase();
}

function toSessionChatKind(chatKind: ChatKind): "direct" | "group" {
	return chatKind === "dm" ? "direct" : "group";
}

export function buildSessionKey(params: {
	agentSlug: string;
	channelType: ChannelType;
	chatKind: ChatKind;
	externalConversationId: string;
	threadId?: string;
}): string {
	const base = [
		"agent",
		normalizeAgentSlug(params.agentSlug),
		params.channelType,
		toSessionChatKind(params.chatKind),
		normalizeConversationId(params.externalConversationId),
	].join(":");
	if (!params.threadId?.trim()) {
		return base;
	}
	return `${base}:thread:${normalizeThreadId(params.threadId)}`;
}

export function buildSessionKeyFromAddress(params: {
	agentSlug: string;
	address: ChannelSessionAddress;
}): string {
	return buildSessionKey({
		agentSlug: params.agentSlug,
		channelType: params.address.channelType,
		chatKind: params.address.chatKind,
		externalConversationId: params.address.externalConversationId,
		threadId: params.address.threadId,
	});
}
