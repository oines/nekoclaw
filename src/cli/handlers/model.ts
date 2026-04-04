import chalk from "chalk";
import { NEKOCLAW_CUSTOM_MODEL_API_KEY_ENV, NEKOCLAW_NAME } from "../../config.js";
import type { AgentSpec, ModelConfig } from "../../types.js";
import type { RuntimeModelsConfig } from "../../model/model-types.js";
import {
	type DiscoveredRuntimeModelEntry,
	fetchBuiltinModelCatalog,
	fetchModelCatalog,
	fetchProxyModelCatalog,
	getBuiltinProviderCatalogTargets,
} from "../../model/catalog.js";
import { probeProxyProtocol, upsertRuntimeModelsConfig } from "../../model/probe.js";
import { MODEL_ENV_MAP } from "../../model/provider-key.js";
import { JsonNekoclawStore } from "../../store/json-store.js";
import { ask, requireValue, type ModelSetOptions } from "./shared.js";

function getModelConfig(agent: AgentSpec, store: JsonNekoclawStore): ModelConfig | undefined {
	return store.getModelConfig(agent.agentId);
}

export function isCustomModel(agent: AgentSpec, store: JsonNekoclawStore): boolean {
	return getModelConfig(agent, store)?.kind === "custom";
}

function uniqueSorted(values: string[]): string[] {
	return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

async function fetchCustomModelCatalog(baseUrl: string, apiKey: string | undefined) {
	return fetchProxyModelCatalog(baseUrl, apiKey);
}

function resolveBuiltinApiKey(
	agent: AgentSpec,
	store: JsonNekoclawStore,
	provider: string,
	override: string | undefined,
): string | undefined {
	return override || store.getProviderKey(agent.agentId, provider) || process.env[MODEL_ENV_MAP[provider] ?? ""];
}

function persistCatalogEntries(
	current: RuntimeModelsConfig | undefined,
	input: {
		provider: string;
		baseUrl: string;
		api: NonNullable<DiscoveredRuntimeModelEntry["sourceApi"]>;
		apiKeyEnv: string;
		entries: DiscoveredRuntimeModelEntry[];
	},
): RuntimeModelsConfig {
	let next = current;
	for (const entry of input.entries) {
		next = upsertRuntimeModelsConfig(next, {
			baseUrl: entry.sourceBaseUrl ?? input.baseUrl,
			api: entry.sourceApi ?? input.api,
			provider: input.provider,
			apiKeyEnv: input.apiKeyEnv,
			modelId: entry.id,
			name: entry.name,
			input: entry.input,
			contextWindow: entry.contextWindow,
			maxTokens: entry.maxTokens,
		});
	}
	return next ?? { providers: {} };
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

	const apiKey = (options.apiKey ??
		(await p.password({
			message: "Enter API key (leave empty if already set or not needed)",
		}))) as string;

	if (p.isCancel(apiKey)) {
		p.cancel("Operation cancelled");
		return;
	}

	const effectiveApiKey = resolveBuiltinApiKey(agent, store, provider, apiKey || undefined);
	const discoveredModels = await fetchBuiltinModelCatalog(provider, effectiveApiKey);
	const availableModels = uniqueSorted(discoveredModels.map((entry) => entry.id));
	const fallbackModel = availableModels[0] ?? "";
	const modelId = (options.model ||
		(await p.select({
			message: "Select a model",
			options: availableModels.length > 0
				? availableModels.map((model) => ({ value: model, label: model }))
				: [{ value: "manual", label: "Enter model ID manually" }],
			initialValue: agent.provider === provider ? agent.modelId : fallbackModel,
		}))) as string;

	if (p.isCancel(modelId)) {
		p.cancel("Operation cancelled");
		return;
	}

	const finalModelId = modelId === "manual"
		? (await p.text({ message: "Enter model ID" })) as string
		: modelId;

	if (p.isCancel(finalModelId)) {
		p.cancel("Operation cancelled");
		return;
	}

	store.setBuiltinModelConfig(agent.agentId, {
		provider,
		modelId: finalModelId,
		apiKey: apiKey || undefined,
		thinkingLevel: agent.thinkingLevel,
	});

	const targets = getBuiltinProviderCatalogTargets(provider, effectiveApiKey);
	if (targets.length > 0) {
		const selected = discoveredModels.find((entry) => entry.id === finalModelId);
		const current = store.readRuntimeModelsConfig(agent.agentId) as RuntimeModelsConfig | undefined;
		let config = current;
		if (discoveredModels.length > 0) {
			config = persistCatalogEntries(config, {
				provider,
				baseUrl: targets[0]!.baseUrl,
				api: targets[0]!.api,
				apiKeyEnv: MODEL_ENV_MAP[provider] ?? "",
				entries: discoveredModels,
			});
		}
		if (!selected) {
			config = upsertRuntimeModelsConfig(config, {
				baseUrl: targets[0]!.baseUrl,
				api: targets[0]!.api,
				provider,
				apiKeyEnv: MODEL_ENV_MAP[provider] ?? "",
				modelId: finalModelId,
			});
		}
		if (config) {
			store.writeRuntimeModelsConfig(agent.agentId, config, {
				source: "builtin-model-set",
				providerId: provider,
				modelId: finalModelId,
			});
		}
	}
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
	let refreshedModels: DiscoveredRuntimeModelEntry[] = [];
	try {
		refreshedModels = await fetchModelCatalog({
			providerId,
			api: probe.api,
			baseUrl,
			apiKey: apiKey || undefined,
		});
	} catch {
		refreshedModels = [];
	}
	const discoveredModels = refreshedModels.length > 0 ? refreshedModels : listedModels;
	const discoveredModel = discoveredModels.find((entry) => entry.id === finalModelId);

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

	let config = store.readRuntimeModelsConfig(updatedAgent.agentId) as RuntimeModelsConfig | undefined;
	if (discoveredModels.length > 0) {
		config = persistCatalogEntries(config, {
			provider: updatedAgent.provider,
			baseUrl: baseUrl.replace(/\/+$/, ""),
			api: probe.api,
			apiKeyEnv: NEKOCLAW_CUSTOM_MODEL_API_KEY_ENV,
			entries: discoveredModels,
		});
	}
	config = upsertRuntimeModelsConfig(config, {
		baseUrl,
		api: probe.api,
		provider: updatedAgent.provider,
		apiKeyEnv: NEKOCLAW_CUSTOM_MODEL_API_KEY_ENV,
		modelId: finalModelId,
		name: discoveredModel?.name,
		input: discoveredModel?.input,
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
		const modelConfig = getModelConfig(agent, store) as Extract<ModelConfig, { kind: "custom" }>;
		try {
			ids = uniqueSorted(
				(
					await fetchModelCatalog({
						providerId: modelConfig.providerId,
						api: modelConfig.api,
						baseUrl: modelConfig.baseUrl,
						apiKey: store.getCustomModelApiKey(agent.agentId),
					})
				).map((entry) => entry.id),
			);
		} catch {
			ids = [];
		}
	} else {
		ids = uniqueSorted(
			(await fetchBuiltinModelCatalog(agent.provider, resolveBuiltinApiKey(agent, store, agent.provider, undefined))).map((entry) => entry.id),
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
