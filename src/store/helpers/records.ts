import { buildSessionKey } from "../../session/key.js";
import type {
	AgentConfig,
	AgentSpec,
	BuiltinModelConfig,
	ChannelSpec,
	ChannelType,
	CustomModelConfig,
	GroupTriggerMode,
	ModelApiFormat,
	NekoclawConfig,
	SessionConfig,
	SessionLastRoute,
	SessionRecord,
} from "../../types.js";
import { defaultPairingConfig } from "../config/defaults.js";
import { NEKOCLAW_CONFIG_VERSION } from "../../types.js";

type LegacyCustomModelConfig = Omit<CustomModelConfig, "providerId"> & { providerId?: string; providerKey?: string };
interface LegacyAgentConfig extends Omit<AgentConfig, "sessions"> {
	sessions?: Record<string, SessionConfig>;
	chats?: Record<string, SessionConfig>;
}

export interface LegacyRuntimeModelProvider {
	baseUrl?: string;
	api?: string;
	apiKey?: string;
	models?: Array<{ id?: string }>;
}

export function getLegacyCustomModelConfig(model: AgentConfig["model"] | undefined): LegacyCustomModelConfig | undefined {
	return model?.kind === "custom" ? (model as LegacyCustomModelConfig) : undefined;
}

function normalizeCustomModelConfig(agent: AgentConfig): AgentConfig {
	const model = getLegacyCustomModelConfig(agent.model);
	if (!model) {
		return agent;
	}
	const normalizedBaseUrl = model.baseUrl.trim().replace(/\/+$/, "");
	const providerId = model.providerId?.trim() || model.providerKey?.trim();
	if (!providerId) {
		throw new Error(`Custom model for agent ${agent.agentId} is missing providerId`);
	}
	return {
		...agent,
		model: {
			...model,
			baseUrl: normalizedBaseUrl,
			providerId,
		},
	};
}

function normalizeLastRoute(
	channelType: ChannelType,
	externalConversationId: string,
	threadId: string | undefined,
	updatedAt: string,
	lastRoute?: SessionLastRoute,
): SessionLastRoute {
	return {
		channelType,
		externalConversationId: lastRoute?.externalConversationId?.trim() || externalConversationId,
		threadId: lastRoute?.threadId?.trim() || threadId,
		updatedAt: lastRoute?.updatedAt || updatedAt,
	};
}

export function normalizeSessionConfig(agentSlug: string, session: SessionConfig): SessionConfig {
	const externalConversationId = session.externalConversationId.trim();
	const threadId = session.threadId?.trim() || undefined;
	const chatTitle = session.chatTitle?.trim() || undefined;
	const modelOverride =
		session.modelOverride?.provider?.trim() && session.modelOverride.modelId?.trim()
			? {
					provider: session.modelOverride.provider.trim(),
					modelId: session.modelOverride.modelId.trim(),
					updatedAt: session.modelOverride.updatedAt || session.updatedAt,
				}
			: undefined;
	return {
		...session,
		externalConversationId,
		chatTitle,
		sessionKey:
			session.sessionKey?.trim() ||
			buildSessionKey({
				agentSlug,
				channelType: session.channelType,
				chatKind: session.chatKind,
				externalConversationId,
				threadId,
			}),
		parentSessionKey: session.parentSessionKey?.trim() || undefined,
		threadId,
		lastRoute: normalizeLastRoute(
			session.channelType,
			externalConversationId,
			threadId,
			session.updatedAt,
			session.lastRoute,
		),
		modelOverride,
		resetGeneration: typeof session.resetGeneration === "number" ? session.resetGeneration : 0,
	};
}

export function normalizeConfig(config: Partial<NekoclawConfig> | undefined): NekoclawConfig {
	const normalized: NekoclawConfig = {
		version: NEKOCLAW_CONFIG_VERSION,
		agents: {},
		pairing: {
			...defaultPairingConfig(),
			...(config?.pairing ?? {}),
		},
	};
	const rawAgents = config?.agents ?? {};
	for (const [slug, rawAgent] of Object.entries(rawAgents)) {
		const legacyAgent = rawAgent as LegacyAgentConfig;
		const normalizedAgent = normalizeCustomModelConfig({
			...legacyAgent,
			sessions: legacyAgent.sessions ?? legacyAgent.chats ?? {},
		});
		const normalizeGroupTrigger = (value: string | undefined): GroupTriggerMode =>
			value === "mention" ? "mention" : "all";
		const telegram = normalizedAgent.channels.telegram
			? {
					...normalizedAgent.channels.telegram,
					groupTrigger: normalizeGroupTrigger(normalizedAgent.channels.telegram.groupTrigger),
				}
			: undefined;
		const napcat = normalizedAgent.channels.napcat
			? {
					...normalizedAgent.channels.napcat,
					groupTrigger: normalizeGroupTrigger(normalizedAgent.channels.napcat.groupTrigger),
				}
			: undefined;
		normalized.agents[slug] = {
			...normalizedAgent,
			channels: {
				telegram,
				napcat,
			},
			admins: (normalizedAgent.admins ?? [])
				.map((admin) => ({
					channelType: admin.channelType,
					externalUserId: admin.externalUserId?.trim() || "",
					displayName: admin.displayName?.trim() || undefined,
					addedAt: admin.addedAt || normalizedAgent.createdAt,
				}))
				.filter((admin) => admin.externalUserId),
			sessions: Object.fromEntries(
				Object.entries(normalizedAgent.sessions).map(([sessionRecordId, session]) => [
					sessionRecordId,
					normalizeSessionConfig(slug, session),
				]),
			),
		};
	}
	return normalized;
}

export function normalizeAgentSpec(slug: string, config: AgentConfig): AgentSpec {
	return {
		agentId: config.agentId,
		slug,
		image: config.image,
		containerName: `nekoclaw-${slug}`,
		enabled: config.enabled,
		provider:
			config.model?.kind === "builtin"
				? config.model.provider
				: config.model?.kind === "custom"
					? config.model.providerId
					: undefined,
		modelId: config.model?.modelId,
		thinkingLevel: config.model?.thinkingLevel,
		lastError: config.lastError,
		createdAt: config.createdAt,
		updatedAt: config.updatedAt,
	};
}

export function normalizeChannelSpec(agentId: string, type: ChannelType, createdAt: string, updatedAt: string): ChannelSpec {
	return {
		agentId,
		type,
		createdAt,
		updatedAt,
	};
}

export function normalizeSessionRecord(
	agentSlug: string,
	agentId: string,
	sessionRecordId: string,
	session: SessionConfig,
): SessionRecord {
	const normalized = normalizeSessionConfig(agentSlug, session);
	return {
		sessionRecordId,
		agentId,
		sessionKey: normalized.sessionKey,
		parentSessionKey: normalized.parentSessionKey,
		channelType: normalized.channelType,
		externalConversationId: normalized.externalConversationId,
		threadId: normalized.threadId,
		chatKind: normalized.chatKind,
		chatTitle: normalized.chatTitle,
		lastRoute: normalized.lastRoute,
		modelOverride: normalized.modelOverride,
		resetGeneration: normalized.resetGeneration,
		status: normalized.status,
		createdAt: normalized.pairedAt,
		updatedAt: normalized.updatedAt,
	};
}

export function toBuiltinModelConfig(input: {
	provider: string;
	modelId: string;
	apiKey?: string;
	thinkingLevel?: AgentSpec["thinkingLevel"];
}): BuiltinModelConfig {
	return {
		kind: "builtin",
		provider: input.provider,
		modelId: input.modelId,
		apiKey: input.apiKey,
		thinkingLevel: input.thinkingLevel,
	};
}
