import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import {
	NEKOCLAW_CONFIG_PATH,
	NEKOCLAW_LEGACY_AGENTS_DIR,
	NEKOCLAW_LEGACY_CHANNELS_DIR,
	NEKOCLAW_LEGACY_CHATS_DIR,
	NEKOCLAW_LEGACY_SECRETS_DIR,
	NEKOCLAW_ROOT_DIR,
} from "../../config.js";
import { buildSessionKey } from "../../session/key.js";
import type {
	AgentConfig,
	AgentSecrets,
	AgentSpec,
	ChannelSpec,
	ModelApiFormat,
	SessionConfig,
	SessionRecord,
} from "../../types.js";
import { readJsonFile, writeJsonFile } from "../fs.js";
import { defaultConfig } from "./defaults.js";
import { ensureDir, readDirectoryJson } from "../helpers/fs.js";
import type { LegacyRuntimeModelProvider } from "./normalize.js";
import { StorePaths } from "../paths.js";

export function hasLegacyConfig(): boolean {
	return [NEKOCLAW_LEGACY_AGENTS_DIR, NEKOCLAW_LEGACY_CHANNELS_DIR, NEKOCLAW_LEGACY_CHATS_DIR, NEKOCLAW_LEGACY_SECRETS_DIR].some(
		(path) => existsSync(path) && readdirSync(path).length > 0,
	);
}

export function migrateLegacyConfigIfNeeded(paths: StorePaths): void {
	if (existsSync(NEKOCLAW_CONFIG_PATH) || !hasLegacyConfig()) {
		return;
	}

	const config = defaultConfig();
	const legacyAgents = readDirectoryJson<AgentSpec>(NEKOCLAW_LEGACY_AGENTS_DIR);
	const legacyChannels = readDirectoryJson<ChannelSpec>(NEKOCLAW_LEGACY_CHANNELS_DIR);
	const legacySessions = readDirectoryJson<SessionRecord>(NEKOCLAW_LEGACY_CHATS_DIR);
	const legacySecrets = new Map<string, AgentSecrets>();
	if (existsSync(NEKOCLAW_LEGACY_SECRETS_DIR)) {
		for (const file of readdirSync(NEKOCLAW_LEGACY_SECRETS_DIR).filter((name) => name.endsWith(".json"))) {
			const agentId = file.replace(/\.json$/, "");
			legacySecrets.set(
				agentId,
				readJsonFile<AgentSecrets>(join(NEKOCLAW_LEGACY_SECRETS_DIR, file), { channelTokens: {}, providerKeys: {} }),
			);
		}
	}

	for (const legacyAgent of legacyAgents) {
		const secrets = legacySecrets.get(legacyAgent.agentId) ?? { channelTokens: {}, providerKeys: {} };
		let model: AgentConfig["model"];
		if (legacyAgent.provider === "custom") {
			const runtimeConfig = readJsonFile<Record<string, unknown>>(paths.getLegacyRuntimeModelsPath(legacyAgent.slug), {});
			const customProviders = (runtimeConfig.providers ?? {}) as Record<string, LegacyRuntimeModelProvider>;
			const customProviderEntries = Object.entries(customProviders);
			const customProviderEntry = customProviderEntries.find(([key]) => key === "custom") ?? customProviderEntries[0];
			const [providerId, customProvider] = customProviderEntry ?? [];
			const customModelId =
				legacyAgent.modelId ??
				(Array.isArray(customProvider?.models) ? customProvider.models.find((entry) => entry.id)?.id : undefined);
			if (customProvider?.baseUrl && customProvider?.api && customModelId) {
				model = {
					kind: "custom",
					baseUrl: customProvider.baseUrl,
					api: customProvider.api as ModelApiFormat,
					providerId:
						typeof providerId === "string" && providerId.trim()
							? providerId
							: "custom",
					modelId: customModelId,
					apiKey: secrets.customModelApiKey ?? customProvider.apiKey,
					thinkingLevel: legacyAgent.thinkingLevel,
				};
			}
		} else if (legacyAgent.provider && legacyAgent.modelId) {
			model = {
				kind: "builtin",
				provider: legacyAgent.provider,
				modelId: legacyAgent.modelId,
				apiKey: secrets.providerKeys[legacyAgent.provider],
				thinkingLevel: legacyAgent.thinkingLevel,
			};
		}

		const telegramChannel = legacyChannels.find(
			(channel) => channel.agentId === legacyAgent.agentId && channel.type === "telegram",
		);
		const sessions = Object.fromEntries(
			legacySessions
				.filter((session) => session.agentId === legacyAgent.agentId)
				.map((session) => [
					session.sessionRecordId,
					{
						externalConversationId: session.externalConversationId,
						channelType: session.channelType,
						chatKind: session.chatKind,
						sessionKey:
							session.sessionKey ||
							buildSessionKey({
								agentSlug: legacyAgent.slug,
								channelType: session.channelType,
								chatKind: session.chatKind,
								externalConversationId: session.externalConversationId,
								threadId: session.threadId,
							}),
						parentSessionKey: session.parentSessionKey,
						threadId: session.threadId,
						lastRoute: session.lastRoute,
						resetGeneration: 0,
						status: session.status,
						pairedAt: session.createdAt,
						updatedAt: session.updatedAt,
					} satisfies SessionConfig,
				]),
		);

		config.agents[legacyAgent.slug] = {
			agentId: legacyAgent.agentId,
			image: legacyAgent.image,
			enabled: legacyAgent.enabled,
			model,
			channels: telegramChannel
				? {
						telegram: {
							token: secrets.channelTokens.telegram,
							addedAt: telegramChannel.createdAt,
							updatedAt: telegramChannel.updatedAt,
						},
					}
				: {},
			sessions,
			admins: [],
			lastError: legacyAgent.lastError,
			createdAt: legacyAgent.createdAt,
			updatedAt: legacyAgent.updatedAt,
		};
	}

	writeJsonFile(NEKOCLAW_CONFIG_PATH, config, { mode: 0o600 });

	const backupDir = join(NEKOCLAW_ROOT_DIR, `legacy-config-${Date.now()}`);
	ensureDir(backupDir);
	for (const path of [NEKOCLAW_LEGACY_AGENTS_DIR, NEKOCLAW_LEGACY_CHANNELS_DIR, NEKOCLAW_LEGACY_CHATS_DIR, NEKOCLAW_LEGACY_SECRETS_DIR]) {
		if (existsSync(path)) {
			renameSync(path, join(backupDir, path.split("/").pop() ?? randomUUID()));
		}
	}
}
