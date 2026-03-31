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

import * as p from "@clack/prompts";

export async function configureBuiltInModel(agentRef: string, store: JsonNekoclawStore, options: ModelSetOptions): Promise<void> {
	const agent = store.getAgentByRef(agentRef);
	const provider = (options.provider ||
		(await p.select({
			message: "Select a model provider",
			options: providerNames().map((p) => ({ value: p, label: p })),
			initialValue: agent.provider || "openai",
		}))) as string;

	if (p.isCancel(provider)) {
		p.cancel("Operation cancelled");
		return;
	}

	const registry = createRegistry(agent, store);
	const availableModels = uniqueSorted(
		registry
			.getAll()
			.filter((model) => model.provider === provider)
			.map((model) => model.id),
	);
	const fallbackModel = availableModels[0] ?? "";
	const modelId = (options.model ||
		(await p.select({
			message: "Select a model",
			options: availableModels.length > 0
				? availableModels.map((m) => ({ value: m, label: m }))
				: [{ value: "custom", label: "Enter model ID manually" }],
			initialValue: agent.provider === provider ? agent.modelId : fallbackModel,
		}))) as string;

	if (p.isCancel(modelId)) {
		p.cancel("Operation cancelled");
		return;
	}

	const finalModelId = modelId === "custom"
		? (await p.text({ message: "Enter model ID" })) as string
		: modelId;

	if (p.isCancel(finalModelId)) {
		p.cancel("Operation cancelled");
		return;
	}

	const apiKey = (options.apiKey ??
		(await p.password({
			message: "Enter API key (leave empty if already set or not needed)",
		}))) as string;

	if (p.isCancel(apiKey)) {
		p.cancel("Operation cancelled");
		return;
	}

	store.setBuiltinModelConfig(agent.agentId, {
		provider,
		modelId: finalModelId,
		apiKey: apiKey || undefined,
		thinkingLevel: agent.thinkingLevel,
	});
	p.note(`Current model: ${provider}/${finalModelId}`, chalk.green("Model updated"));
}

export async function configureCustomModel(agentRef: string, store: JsonNekoclawStore, options: ModelSetOptions): Promise<void> {
	const agent = store.getAgentByRef(agentRef);
	const baseUrl = (options.baseUrl || (await p.text({
		message: "Enter custom model base URL",
		placeholder: "https://api.openai.com/v1",
		validate: (v) => (!v ? "Base URL is required" : undefined),
	}))) as string;

	if (p.isCancel(baseUrl)) {
		p.cancel("Operation cancelled");
		return;
	}

	const providerId = (options.providerId || (await p.text({
		message: "Enter custom provider ID",
		placeholder: "my-provider",
		validate: (v) => (!v ? "Provider ID is required" : undefined),
	}))) as string;

	if (p.isCancel(providerId)) {
		p.cancel("Operation cancelled");
		return;
	}

	const apiKey = (options.apiKey || (await p.password({
		message: "Enter API key (leave empty if none)",
	}))) as string;

	if (p.isCancel(apiKey)) {
		p.cancel("Operation cancelled");
		return;
	}

	const s = p.spinner();
	s.start("Fetching available models...");
	const listedModels = await fetchCustomModelIds(baseUrl, apiKey || undefined);
	s.stop("Model list fetched");

	const modelId = (options.model ||
		(await p.select({
			message: "Select a model",
			options: listedModels.length > 0
				? listedModels.map((m) => ({ value: m, label: m }))
				: [{ value: "manual", label: "Enter model ID manually" }],
			initialValue: listedModels[0],
		}))) as string;

	if (p.isCancel(modelId)) {
		p.cancel("Operation cancelled");
		return;
	}

	const finalModelId = modelId === "manual"
		? (await p.text({ message: "Enter model ID", validate: (v) => (!v ? "Model ID is required" : undefined) })) as string
		: modelId;

	if (p.isCancel(finalModelId)) {
		p.cancel("Operation cancelled");
		return;
	}

	s.start("Probing model endpoint...");
	const probe = await probeProxyProtocol({
		baseUrl,
		apiKey: apiKey || "",
		modelId: finalModelId,
	});
	s.stop("Probe successful");

	const updatedAgent = store.setCustomModelConfig(agent.agentId, {
		baseUrl: baseUrl.replace(/\/+$/, ""),
		api: probe.api,
		providerId,
		modelId: finalModelId,
		apiKey: apiKey || undefined,
		thinkingLevel: agent.thinkingLevel,
	});

	if (!updatedAgent.provider) {
		throw new Error(`Custom provider ID was not assigned for ${updatedAgent.slug}`);
	}

	const config = buildCustomRuntimeConfig(baseUrl, probe.api, updatedAgent.provider, finalModelId);
	store.writeRuntimeModelsConfig(updatedAgent.agentId, config, {
		baseUrl,
		api: probe.api,
		providerId: updatedAgent.provider,
		modelId: finalModelId,
	});

	p.note(`Current model: ${updatedAgent.provider}/${finalModelId}`, chalk.green("Model updated"));
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
