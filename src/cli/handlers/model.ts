import chalk from "chalk";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { NEKOCLAW_CUSTOM_MODEL_API_KEY_ENV, NEKOCLAW_NAME } from "../../config.js";
import type { AgentSpec, ModelConfig } from "../../types.js";
import type { RuntimeModelsConfig } from "../../model/model-types.js";
import { probeProxyProtocol } from "../../model/probe.js";
import { JsonNekoclawStore } from "../../store/json-store.js";
import { ask, requireValue, type ModelSetOptions } from "./shared.js";

function getModelConfig(agent: AgentSpec, store: JsonNekoclawStore): ModelConfig | undefined {
	return store.getModelConfig(agent.agentId);
}

export function isCustomModel(agent: AgentSpec, store: JsonNekoclawStore): boolean {
	return getModelConfig(agent, store)?.kind === "custom";
}

function getCustomRuntimeProviderConfig(
	config: RuntimeModelsConfig | undefined,
	providerId: string,
): RuntimeModelsConfig["providers"][string] | undefined {
	return config?.providers[providerId];
}

function createRegistry(agent: AgentSpec, store: JsonNekoclawStore): ModelRegistry {
	const authStorage = AuthStorage.inMemory();
	const modelConfig = getModelConfig(agent, store);
	if (agent.provider && modelConfig?.kind === "custom") {
		const customKey = store.getCustomModelApiKey(agent.agentId);
		if (customKey) {
			authStorage.setRuntimeApiKey(agent.provider, customKey);
		}
	} else if (agent.provider) {
		const key = store.getProviderKey(agent.agentId, agent.provider);
		if (key) {
			authStorage.setRuntimeApiKey(agent.provider, key);
		}
	}
	return new ModelRegistry(authStorage, store.getRuntimeModelsPath(agent.slug));
}

function uniqueSorted(values: string[]): string[] {
	return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

async function fetchCustomModelIds(baseUrl: string, apiKey: string | undefined): Promise<string[]> {
	const normalized = baseUrl.replace(/\/+$/, "");
	const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : undefined;
	const response = await fetch(`${normalized}/models`, { headers });
	if (!response.ok) {
		return [];
	}
	const payload = (await response.json()) as { data?: Array<{ id?: string }> };
	return uniqueSorted((payload.data ?? []).map((entry) => entry.id).filter(Boolean) as string[]);
}

function buildCustomRuntimeConfig(
	baseUrl: string,
	api: "openai-completions" | "anthropic-messages",
	providerId: string,
	modelId: string,
): RuntimeModelsConfig {
	return {
		providers: {
			[providerId]: {
				baseUrl: baseUrl.replace(/\/+$/, ""),
				api,
				apiKey: NEKOCLAW_CUSTOM_MODEL_API_KEY_ENV,
				authHeader: api === "openai-completions" ? true : undefined,
				compat:
					api === "openai-completions"
						? {
								supportsDeveloperRole: false,
								supportsReasoningEffort: false,
							}
						: undefined,
				models: [
					{
						id: modelId,
						name: modelId,
						reasoning: false,
						input: ["text"],
						contextWindow: 200000,
						maxTokens: 16384,
						cost: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
						},
					},
				],
			},
		},
	};
}

export function providerNames(): string[] {
	return [
		"anthropic",
		"openai",
		"google",
		"azure-openai-responses",
		"openrouter",
		"xai",
		"groq",
		"mistral",
		"zai",
		"cerebras",
		"huggingface",
		"kimi-coding",
		"minimax",
		"minimax-cn",
		"opencode",
		"opencode-go",
	];
}

export async function configureBuiltInModel(agentRef: string, store: JsonNekoclawStore, options: ModelSetOptions): Promise<void> {
	const agent = store.getAgentByRef(agentRef);
	const provider =
		options.provider ||
		(await ask(`Provider (${providerNames().join(", ")})`, agent.provider || "openai"));
	const registry = createRegistry(agent, store);
	const availableModels = uniqueSorted(
		registry
			.getAll()
			.filter((model) => model.provider === provider)
			.map((model) => model.id),
	);
	const fallbackModel = availableModels[0] ?? "";
	const modelId =
		options.model ||
		(await ask(
			availableModels.length > 0
				? `Model (${availableModels.join(", ")})`
				: "Model",
			agent.provider === provider ? agent.modelId : fallbackModel,
		));
	const apiKey = options.apiKey ?? (await ask("API key (saved to local config, leave empty if none)", ""));
	store.setBuiltinModelConfig(agent.agentId, {
		provider,
		modelId,
		apiKey: apiKey || undefined,
		thinkingLevel: agent.thinkingLevel,
	});
	console.log(chalk.green(`Model updated for ${agent.slug}`));
	console.log(`Current model: ${provider}/${modelId}`);
}

export async function configureCustomModel(agentRef: string, store: JsonNekoclawStore, options: ModelSetOptions): Promise<void> {
	const agent = store.getAgentByRef(agentRef);
	const baseUrl = options.baseUrl || (await ask("Model URL"));
	const providerId = requireValue(options.providerId?.trim(), "provider ID (--provider-id)");
	const apiKey = options.apiKey || (await ask("API key (leave empty if none)", ""));
	const listedModels = await fetchCustomModelIds(baseUrl, apiKey || undefined);
	const modelId =
		options.model ||
		(await ask(
			listedModels.length > 0 ? `Model (${listedModels.join(", ")})` : "Model name",
			listedModels[0],
		));
	const probe = await probeProxyProtocol({
		baseUrl,
		apiKey: apiKey || "",
		modelId,
	});
	const updatedAgent = store.setCustomModelConfig(agent.agentId, {
		baseUrl: baseUrl.replace(/\/+$/, ""),
		api: probe.api,
		providerId,
		modelId,
		apiKey: apiKey || undefined,
		thinkingLevel: agent.thinkingLevel,
	});
	if (!updatedAgent.provider) {
		throw new Error(`Custom provider ID was not assigned for ${updatedAgent.slug}`);
	}
	const config = buildCustomRuntimeConfig(baseUrl, probe.api, updatedAgent.provider, modelId);
	store.writeRuntimeModelsConfig(updatedAgent.agentId, config, {
		baseUrl,
		api: probe.api,
		providerId: updatedAgent.provider,
		modelId,
	});
	console.log(chalk.green(`Model updated for ${agent.slug}`));
	console.log(`Current model: ${updatedAgent.provider}/${modelId}`);
}

export async function handleModelCurrent(agentRef: string, store: JsonNekoclawStore): Promise<void> {
	const agent = store.getAgentByRef(requireValue(agentRef, "agent"));
	if (!agent.provider || !agent.modelId) {
		console.log("No model configured.");
		return;
	}
	console.log(`${agent.provider}/${agent.modelId}`);
}

export async function handleModelList(agentRef: string, store: JsonNekoclawStore): Promise<void> {
	const agent = store.getAgentByRef(requireValue(agentRef, "agent"));
	if (!agent.provider) {
		throw new Error("This agent does not have a model provider yet. Run model set first.");
	}
	if (isCustomModel(agent, store)) {
		const config = store.readRuntimeModelsConfig(agent.agentId) as unknown as RuntimeModelsConfig | undefined;
		const provider = getCustomRuntimeProviderConfig(config, agent.provider);
		const ids = uniqueSorted((provider?.models ?? []).map((entry) => entry.id).filter(Boolean) as string[]);
		if (ids.length === 0) {
			console.log("This custom model source does not expose a model list.");
			return;
		}
		for (const id of ids) {
			console.log(`${id}${id === agent.modelId ? "  (current)" : ""}`);
		}
		return;
	}
	const registry = createRegistry(agent, store);
	for (const id of uniqueSorted(registry.getAll().filter((model) => model.provider === agent.provider).map((model) => model.id))) {
		console.log(`${id}${id === agent.modelId ? "  (current)" : ""}`);
	}
}

export async function handleModelSet(agentRef: string, options: ModelSetOptions, store: JsonNekoclawStore): Promise<void> {
	const agent = store.getAgentByRef(requireValue(agentRef, "agent"));
	const mode =
		options.source ||
		(options.baseUrl ? "custom" : options.provider ? "built-in" : undefined) ||
		(await ask("Model source (built-in/custom)", isCustomModel(agent, store) ? "custom" : "built-in"));
	if (mode === "custom") {
		await configureCustomModel(agent.agentId, store, options);
		return;
	}
	await configureBuiltInModel(agent.agentId, store, options);
}
