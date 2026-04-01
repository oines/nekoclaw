import type { RuntimeModelEntry, RuntimeModelProvider, RuntimeModelsConfig } from "./model-types.js";
import type { ModelApiFormat, ProxyProbeResult } from "../types.js";

interface ProbeOptions {
	baseUrl: string;
	apiKey: string;
	modelId: string;
	api?: ModelApiFormat;
}

function trimTrailingSlash(value: string): string {
	return value.replace(/\/+$/, "");
}

async function parseJson(response: Response): Promise<unknown> {
	const text = await response.text();
	try {
		return text ? JSON.parse(text) : undefined;
	} catch {
		return text;
	}
}

async function assertOk(response: Response, label: string): Promise<unknown> {
	const payload = await parseJson(response);
	if (!response.ok) {
		throw new Error(`${label} failed with ${response.status}: ${typeof payload === "string" ? payload : JSON.stringify(payload)}`);
	}
	return payload;
}

async function probeOpenAiCompatible(baseUrl: string, apiKey: string, modelId: string): Promise<ProxyProbeResult> {
	const normalized = trimTrailingSlash(baseUrl);
	const headers = {
		authorization: `Bearer ${apiKey}`,
		"content-type": "application/json",
	};
	const details: string[] = [];

	const modelsResponse = await fetch(`${normalized}/models`, {
		headers: { authorization: `Bearer ${apiKey}` },
	});
	await assertOk(modelsResponse, "GET /models");
	details.push("GET /models ok");

	const completionResponse = await fetch(`${normalized}/chat/completions`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			model: modelId,
			messages: [{ role: "user", content: "ping" }],
			max_tokens: 1,
			temperature: 0,
		}),
	});
	await assertOk(completionResponse, "POST /chat/completions");
	details.push("POST /chat/completions ok");

	return {
		api: "openai-completions",
		baseUrl: normalized,
		modelId,
		modelsCheckOk: true,
		generationCheckOk: true,
		details,
	};
}

async function probeAnthropicCompatible(baseUrl: string, apiKey: string, modelId: string): Promise<ProxyProbeResult> {
	const normalized = trimTrailingSlash(baseUrl);
	const headers = {
		"x-api-key": apiKey,
		"anthropic-version": "2023-06-01",
		"content-type": "application/json",
	};
	const details: string[] = [];

	const messageResponse = await fetch(`${normalized}/messages`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			model: modelId,
			max_tokens: 1,
			messages: [{ role: "user", content: "ping" }],
		}),
	});
	await assertOk(messageResponse, "POST /messages");
	details.push("POST /messages ok");

	return {
		api: "anthropic-messages",
		baseUrl: normalized,
		modelId,
		modelsCheckOk: false,
		generationCheckOk: true,
		details,
	};
}

export async function probeProxyProtocol(options: ProbeOptions): Promise<ProxyProbeResult> {
	const { baseUrl, apiKey, modelId, api } = options;
	if (api === "openai-completions") {
		return probeOpenAiCompatible(baseUrl, apiKey, modelId);
	}
	if (api === "anthropic-messages") {
		return probeAnthropicCompatible(baseUrl, apiKey, modelId);
	}

	const errors: string[] = [];
	try {
		return await probeOpenAiCompatible(baseUrl, apiKey, modelId);
	} catch (error) {
		errors.push(`openai-completions: ${error instanceof Error ? error.message : String(error)}`);
	}
	try {
		return await probeAnthropicCompatible(baseUrl, apiKey, modelId);
	} catch (error) {
		errors.push(`anthropic-messages: ${error instanceof Error ? error.message : String(error)}`);
	}
	throw new Error(`Could not identify proxy protocol.\n${errors.join("\n")}`);
}

interface RuntimeModelConfigOptions {
	provider: string;
	baseUrl: string;
	api: ModelApiFormat;
	apiKeyEnv: string;
	modelId: string;
}

function createRuntimeModelEntry(modelId: string): RuntimeModelEntry {
	return {
		id: modelId,
		name: modelId,
	};
}

function createRuntimeModelProvider(options: RuntimeModelConfigOptions): RuntimeModelProvider {
	return {
		baseUrl: trimTrailingSlash(options.baseUrl),
		api: options.api,
		apiKey: options.apiKeyEnv,
		authHeader: options.api === "openai-completions" ? true : undefined,
		models: [createRuntimeModelEntry(options.modelId)],
	};
}

export function buildRuntimeModelsConfig(options: RuntimeModelConfigOptions): RuntimeModelsConfig {
	return {
		providers: {
			[options.provider]: createRuntimeModelProvider(options),
		},
	};
}

export function upsertRuntimeModelsConfig(
	current: RuntimeModelsConfig | undefined,
	options: RuntimeModelConfigOptions,
): RuntimeModelsConfig {
	const existing = current ?? { providers: {} };
	const providers = { ...existing.providers };
	const provider = {
		...(providers[options.provider] ?? createRuntimeModelProvider(options)),
		baseUrl: trimTrailingSlash(options.baseUrl),
		api: options.api,
		apiKey: options.apiKeyEnv,
		authHeader: options.api === "openai-completions" ? true : undefined,
	};
	const existingModels = Array.isArray(provider.models) ? [...provider.models] : [];
	if (!existingModels.some((entry) => entry.id === options.modelId)) {
		existingModels.push(createRuntimeModelEntry(options.modelId));
	}
	provider.models = existingModels;
	providers[options.provider] = provider;
	return {
		...existing,
		providers,
	};
}
