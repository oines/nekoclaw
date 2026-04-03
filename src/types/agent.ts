import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { ChannelType, ChatKind } from "./common.js";
import type { TelegramChannelConfig, NapcatChannelConfig } from "./channel-config.js";
import type { ModelConfig } from "./model.js";
import type { SessionConfig } from "./session.js";

export interface AdminIdentity {
	channelType: ChannelType;
	externalUserId: string;
	displayName?: string;
	addedAt: string;
}

export interface AgentConfig {
	agentId: string;
	image: string;
	enabled: boolean;
	model?: ModelConfig;
	channels: {
		telegram?: TelegramChannelConfig;
		napcat?: NapcatChannelConfig;
	};
	admins: AdminIdentity[];
	sessions: Record<string, SessionConfig>;
	lastError?: string;
	createdAt: string;
	updatedAt: string;
}

export interface PairingConfig {
	ttlMinutes: number;
	repromptCooldownSeconds: number;
}

export interface NekoclawConfig {
	version: 1;
	agents: Record<string, AgentConfig>;
	pairing: PairingConfig;
}

export interface AgentSpec {
	agentId: string;
	slug: string;
	image: string;
	containerName: string;
	enabled: boolean;
	provider?: string;
	modelId?: string;
	thinkingLevel?: ThinkingLevel;
	lastError?: string;
	createdAt: string;
	updatedAt: string;
}

export interface PairRequest {
	pairingId: string;
	code: string;
	agentId: string;
	channelType: ChannelType;
	externalConversationId: string;
	chatKind: ChatKind;
	sessionKey: string;
	parentSessionKey?: string;
	threadId?: string;
	senderId?: string;
	senderName?: string;
	chatTitle?: string;
	status: "pending" | "accepted" | "rejected" | "expired";
	createdAt: string;
	expiresAt: string;
	lastPromptedAt?: string;
	updatedAt: string;
}

export interface AgentSecrets {
	channelTokens: Partial<Record<ChannelType, string>>;
	providerKeys: Record<string, string>;
	customModelApiKey?: string;
}
