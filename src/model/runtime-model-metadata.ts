import { getModels, getProviders } from "@mariozechner/pi-ai";
import type { RuntimeModelEntry, RuntimeModelProvider, RuntimeModelsConfig } from "./model-types.js";

export type RuntimeModelInputKind = "text" | "image";

export interface RuntimeModelLimits {
	contextWindow?: number;
	maxTokens?: number;
}

function normalizeBaseUrl(value: string | undefined): string | undefined {
	return value ? value.replace(/\/+$/, "").toLowerCase() : undefined;
}

function toPositiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function pickPositiveNumber(values: Iterable<unknown>): number | undefined {
	for (const value of values) {
		const resolved = toPositiveNumber(value);
		if (resolved !== undefined) {
			return resolved;
		}
	}
	return undefined;
}

function uniqueInputs(values: Iterable<string>): RuntimeModelInputKind[] {
	const normalized = new Set<RuntimeModelInputKind>();
	for (const value of values) {
		if (value === "text" || value === "image") {
			normalized.add(value);
		}
	}
	return Array.from(normalized);
}

function deriveInputFromCapabilities(capabilities: string[] | undefined): RuntimeModelInputKind[] | undefined {
	if (!capabilities?.length) {
		return undefined;
	}
	const inputs = new Set<RuntimeModelInputKind>();
	for (const capability of capabilities) {
		const normalized = capability.trim().toLowerCase();
		if (normalized === "text") {
			inputs.add("text");
		}
		if (normalized === "image" || normalized === "vision") {
			inputs.add("image");
		}
	}
	return inputs.size > 0 ? Array.from(inputs) : undefined;
}

export function normalizeRuntimeModelEntryInput(entry: RuntimeModelEntry | undefined): RuntimeModelInputKind[] | undefined {
	if (!entry) {
		return undefined;
	}
	const explicit = uniqueInputs(entry.input ?? []);
	if (explicit.length > 0) {
		return explicit;
	}
	return deriveInputFromCapabilities(entry.capabilities);
}

function normalizeRuntimeModelLimits(entry: RuntimeModelEntry | undefined): RuntimeModelLimits | undefined {
	if (!entry) {
		return undefined;
	}
	const contextWindow = toPositiveNumber(entry.contextWindow);
	const maxTokens = toPositiveNumber(entry.maxTokens);
	if (contextWindow === undefined && maxTokens === undefined) {
		return undefined;
	}
	return {
		contextWindow,
		maxTokens,
	};
}

function inferInputFromBuiltins(input: {
	modelId: string;
	api?: string;
	baseUrl?: string;
}): RuntimeModelInputKind[] | undefined {
	const targetBaseUrl = normalizeBaseUrl(input.baseUrl);
	const exactMatches: RuntimeModelInputKind[][] = [];
	const fallbackMatches: RuntimeModelInputKind[][] = [];
	for (const provider of getProviders()) {
		for (const model of getModels(provider)) {
			if (model.id !== input.modelId) {
				continue;
			}
			if (input.api && model.api !== input.api) {
				continue;
			}
			const normalized = uniqueInputs(model.input);
			if (normalized.length === 0) {
				continue;
			}
			if (targetBaseUrl && normalizeBaseUrl(model.baseUrl) === targetBaseUrl) {
				exactMatches.push(normalized);
				continue;
			}
			fallbackMatches.push(normalized);
		}
	}
	return exactMatches[0] ?? fallbackMatches[0];
}

function inferLimitsFromBuiltins(input: {
	modelId: string;
	api?: string;
	baseUrl?: string;
}): RuntimeModelLimits | undefined {
	const targetBaseUrl = normalizeBaseUrl(input.baseUrl);
	const exactMatches: RuntimeModelLimits[] = [];
	const fallbackMatches: RuntimeModelLimits[] = [];
	for (const provider of getProviders()) {
		for (const model of getModels(provider)) {
			if (model.id !== input.modelId) {
				continue;
			}
			if (input.api && model.api !== input.api) {
				continue;
			}
			const candidate = model as {
				baseUrl?: string;
				contextWindow?: number;
				maxTokens?: number;
			};
			const limits = {
				contextWindow: toPositiveNumber(candidate.contextWindow),
				maxTokens: toPositiveNumber(candidate.maxTokens),
			};
			if (limits.contextWindow === undefined && limits.maxTokens === undefined) {
				continue;
			}
			if (targetBaseUrl && normalizeBaseUrl(candidate.baseUrl) === targetBaseUrl) {
				exactMatches.push(limits);
				continue;
			}
			fallbackMatches.push(limits);
		}
	}
	return exactMatches[0] ?? fallbackMatches[0];
}

function inferInputFromModelId(modelId: string): RuntimeModelInputKind[] | undefined {
	const normalized = modelId.toLowerCase();
	if (/(?:^|[/:_-])(vision|vl)(?:$|[/:_-])/.test(normalized)) {
		return ["text", "image"];
	}
	if (/(gemini|gpt-4o|claude-3|claude-4|pixtral|llava|qwen.*vl|minicpm.*v|molmo)/.test(normalized)) {
		return ["text", "image"];
	}
	return undefined;
}

export function resolveRuntimeModelInput(
	config: RuntimeModelsConfig | undefined,
	providerId: string,
	modelId: string,
): RuntimeModelInputKind[] | undefined {
	const provider = config?.providers?.[providerId];
	const entry = provider?.models?.find((candidate) => candidate.id === modelId);
	const fromEntry = normalizeRuntimeModelEntryInput(entry);
	if (fromEntry?.length) {
		return fromEntry;
	}
	const fromBuiltins = inferInputFromBuiltins({
		modelId,
		api: provider?.api,
		baseUrl: provider?.baseUrl,
	});
	if (fromBuiltins?.length) {
		return fromBuiltins;
	}
	return inferInputFromModelId(modelId);
}

export function resolveRuntimeModelLimits(input: {
	config?: RuntimeModelsConfig;
	providerId: string;
	modelId: string;
	api?: string;
	baseUrl?: string;
}): RuntimeModelLimits | undefined {
	const provider = input.config?.providers?.[input.providerId];
	const entry = provider?.models?.find((candidate) => candidate.id === input.modelId);
	const fromEntry = normalizeRuntimeModelLimits(entry);
	if (fromEntry) {
		return fromEntry;
	}
	return inferLimitsFromBuiltins({
		modelId: input.modelId,
		api: input.api ?? provider?.api,
		baseUrl: input.baseUrl ?? provider?.baseUrl,
	});
}

export function extractRuntimeModelLimits(value: unknown): RuntimeModelLimits | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const contextWindow = pickPositiveNumber([
		record.contextWindow,
		record.context_window,
		record.context_length,
		record.max_context_length,
		record.max_input_tokens,
		record.maxInputTokens,
		typeof record.architecture === "object" && record.architecture !== null
			? (record.architecture as Record<string, unknown>).context_length
			: undefined,
		typeof record.top_provider === "object" && record.top_provider !== null
			? (record.top_provider as Record<string, unknown>).context_length
			: undefined,
	]);
	const maxTokens = pickPositiveNumber([
		record.maxTokens,
		record.max_tokens,
		record.max_completion_tokens,
		record.max_output_tokens,
		record.output_token_limit,
		typeof record.top_provider === "object" && record.top_provider !== null
			? (record.top_provider as Record<string, unknown>).max_completion_tokens
			: undefined,
	]);
	if (contextWindow === undefined && maxTokens === undefined) {
		return undefined;
	}
	return {
		contextWindow,
		maxTokens,
	};
}

export function buildRuntimeModelEntryMetadata(input: {
	providerId: string;
	provider?: RuntimeModelProvider;
	modelId: string;
}): Pick<RuntimeModelEntry, "input" | "capabilities"> {
	const normalizedInput =
		normalizeRuntimeModelEntryInput(input.provider?.models?.find((entry) => entry.id === input.modelId)) ??
		resolveRuntimeModelInput(
			input.provider
				? {
						providers: {
							[input.providerId]: input.provider,
						},
					}
				: undefined,
			input.providerId,
			input.modelId,
		);
	if (!normalizedInput?.length) {
		return {};
	}
	return {
		input: normalizedInput,
		capabilities: [
			...(normalizedInput.includes("text") ? ["text"] : []),
			...(normalizedInput.includes("image") ? ["vision"] : []),
		],
	};
}
