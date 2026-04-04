import chalk from "chalk";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { NEKOCLAW_CUSTOM_MODEL_API_KEY_ENV, NEKOCLAW_NAME } from "../../config.js";
import type { AgentSpec, ModelConfig } from "../../types.js";
import type { RuntimeModelsConfig } from "../../model/model-types.js";
import { fetchProxyModelCatalog, probeProxyProtocol, upsertRuntimeModelsConfig } from "../../model/probe.js";
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

async function fetchCustomModelCatalog(baseUrl: string, apiKey: string | undefined) {
	return fetchProxyModelCatalog(baseUrl, apiKey);
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
	const listedModels = await fetchCustomModelCatalog(baseUrl, apiKey || undefined);
	s.stop("Model list fetched");
	const listedModelIds = uniqueSorted(listedModels.map((entry) => entry.id));

	const modelId = (options.model ||
		(await p.select({
			message: "Select a model",
			options: listedModelIds.length > 0
				? listedModelIds.map((m) => ({ value: m, label: m }))
				: [{ value: "manual", label: "Enter model ID manually" }],
			initialValue: listedModelIds[0],
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
	const discoveredModel = listedModels.find((entry) => entry.id === finalModelId);

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

	const config = upsertRuntimeModelsConfig(store.readRuntimeModelsConfig(updatedAgent.agentId) as RuntimeModelsConfig | undefined, {
		baseUrl,
		api: probe.api,
		provider: updatedAgent.provider,
		apiKeyEnv: NEKOCLAW_CUSTOM_MODEL_API_KEY_ENV,
		modelId: finalModelId,
		name: discoveredModel?.name,
		contextWindow: discoveredModel?.contextWindow,
		maxTokens: discoveredModel?.maxTokens,
	});
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

import Table from "cli-table3";

export async function handleModelList(agentRef: string, store: JsonNekoclawStore): Promise<void> {
	const agent = store.getAgentByRef(requireValue(agentRef, "agent"));
	if (!agent.provider) {
		throw new Error("This agent does not have a model provider yet. Run model set first.");
	}

	let ids: string[] = [];
	if (isCustomModel(agent, store)) {
		const config = store.readRuntimeModelsConfig(agent.agentId) as unknown as RuntimeModelsConfig | undefined;
		const provider = getCustomRuntimeProviderConfig(config, agent.provider);
		ids = uniqueSorted((provider?.models ?? []).map((entry) => entry.id).filter(Boolean) as string[]);
	} else {
		const registry = createRegistry(agent, store);
		ids = uniqueSorted(
			registry
				.getAll()
				.filter((model) => model.provider === agent.provider)
				.map((model) => model.id),
		);
	}

	if (ids.length === 0) {
		console.log("No models found for this provider.");
		return;
	}

	const table = new Table({
		head: ["MODEL ID", "STATUS"].map((h) => chalk.bold(h)),
		chars: { mid: "", "left-mid": "", "mid-mid": "", "right-mid": "" },
	});

	for (const id of ids) {
		const isCurrent = id === agent.modelId;
		table.push([isCurrent ? chalk.cyan(id) : id, isCurrent ? chalk.green("current") : "-"]);
	}

	console.log(table.toString());
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
