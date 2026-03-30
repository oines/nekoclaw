import { existsSync } from "node:fs";
import { normalizeCustomBaseUrl } from "../model/provider-key.js";
import type { AgentSpec, ModelApiFormat } from "../types.js";
import { readJsonFile, writeJsonFile } from "./fs.js";
import { ConfigRepository } from "./config-repository.js";
import { nowIso, toBuiltinModelConfig } from "./helpers.js";
import { StorePaths } from "./paths.js";

export class ModelStore {
	constructor(
		private readonly repo: ConfigRepository,
		private readonly paths: StorePaths,
	) {}

	setBuiltinModelConfig(
		agentRef: string,
		input: { provider: string; modelId: string; apiKey?: string; thinkingLevel?: AgentSpec["thinkingLevel"] },
	): AgentSpec {
		return this.repo.updateConfig((config) => {
			for (const [slug, current] of Object.entries(config.agents)) {
				if (slug !== agentRef && current.agentId !== agentRef) {
					continue;
				}
				current.model = toBuiltinModelConfig(input);
				current.lastError = undefined;
				current.updatedAt = nowIso();
				return {
					agentId: current.agentId,
					slug,
					image: current.image,
					containerName: `nekoclaw-${slug}`,
					enabled: current.enabled,
					provider: input.provider,
					modelId: input.modelId,
					thinkingLevel: input.thinkingLevel,
					lastError: current.lastError,
					createdAt: current.createdAt,
					updatedAt: current.updatedAt,
				};
			}
			throw new Error(`Unknown agent "${agentRef}"`);
		});
	}

	setCustomModelConfig(
		agentRef: string,
		input: {
			baseUrl: string;
			api: ModelApiFormat;
			providerId: string;
			modelId: string;
			apiKey?: string;
			thinkingLevel?: AgentSpec["thinkingLevel"];
		},
	): AgentSpec {
		return this.repo.updateConfig((config) => {
			for (const [slug, current] of Object.entries(config.agents)) {
				if (slug !== agentRef && current.agentId !== agentRef) {
					continue;
				}
				const providerId = input.providerId.trim();
				if (!providerId) {
					throw new Error("Custom model provider ID is required");
				}
				current.model = {
					kind: "custom",
					baseUrl: normalizeCustomBaseUrl(input.baseUrl),
					api: input.api,
					providerId,
					modelId: input.modelId,
					apiKey: input.apiKey,
					thinkingLevel: input.thinkingLevel,
				};
				current.lastError = undefined;
				current.updatedAt = nowIso();
				return {
					agentId: current.agentId,
					slug,
					image: current.image,
					containerName: `nekoclaw-${slug}`,
					enabled: current.enabled,
					provider: current.model.providerId,
					modelId: input.modelId,
					thinkingLevel: input.thinkingLevel,
					lastError: current.lastError,
					createdAt: current.createdAt,
					updatedAt: current.updatedAt,
				};
			}
			throw new Error(`Unknown agent "${agentRef}"`);
		});
	}

	readRuntimeModelsConfig(agentRef: string): Record<string, unknown> | undefined {
		const { slug } = this.repo.getAgentEntry(agentRef);
		const path = this.paths.getRuntimeModelsPath(slug);
		if (!existsSync(path)) {
			return undefined;
		}
		return readJsonFile<Record<string, unknown>>(path, {});
	}

	writeRuntimeModelsConfig(agentRef: string, config: Record<string, unknown>): void {
		const { slug } = this.repo.getAgentEntry(agentRef);
		writeJsonFile(this.paths.getRuntimeModelsPath(slug), config);
	}

	getModelConfig(agentRef: string) {
		return this.repo.getAgentEntry(agentRef).config.model;
	}

	getProviderKey(agentId: string, provider: string): string | undefined {
		const { config } = this.repo.getAgentEntryById(agentId);
		return config.model?.kind === "builtin" && config.model.provider === provider ? config.model.apiKey : undefined;
	}

	getCustomModelApiKey(agentId: string): string | undefined {
		const { config } = this.repo.getAgentEntryById(agentId);
		return config.model?.kind === "custom" ? config.model.apiKey : undefined;
	}

	getRuntimeModelsPath(slug: string): string {
		return this.paths.getRuntimeModelsPath(slug);
	}
}
