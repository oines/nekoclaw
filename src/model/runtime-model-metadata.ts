import type { RuntimeModelEntry, RuntimeModelsConfig } from "./model-types.js";

export type RuntimeModelInputKind = "text" | "image";

export interface RuntimeModelLimits {
	contextWindow?: number;
	maxTokens?: number;
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

function extractInputTokens(value: unknown): string[] {
	if (typeof value === "string") {
		return value
			.split(/[^a-z0-9]+/i)
			.map((token) => token.trim().toLowerCase())
			.filter(Boolean);
	}
	if (Array.isArray(value)) {
		return value.flatMap((entry) => extractInputTokens(entry));
	}
	return [];
}

function uniqueInputs(values: Iterable<string>): RuntimeModelInputKind[] {
	const normalized = new Set<RuntimeModelInputKind>();
	for (const value of values) {
		switch (value.trim().toLowerCase()) {
			case "text":
				normalized.add("text");
				break;
			case "image":
			case "images":
			case "vision":
				normalized.add("image");
				break;
		}
	}
	return Array.from(normalized);
}

function deriveInputFromCapabilities(capabilities: string[] | undefined): RuntimeModelInputKind[] | undefined {
	if (!capabilities?.length) {
		return undefined;
	}
	const inputs = uniqueInputs(capabilities);
	return inputs.length > 0 ? inputs : undefined;
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

function extractInputsFromRecord(record: Record<string, unknown>): RuntimeModelInputKind[] | undefined {
	const architecture = typeof record.architecture === "object" && record.architecture !== null
		? (record.architecture as Record<string, unknown>)
		: undefined;
	const modalities = typeof record.modalities === "object" && record.modalities !== null
		? (record.modalities as Record<string, unknown>)
		: undefined;
	const topProvider = typeof record.top_provider === "object" && record.top_provider !== null
		? (record.top_provider as Record<string, unknown>)
		: undefined;

	const inputs = uniqueInputs([
		...extractInputTokens(record.input),
		...extractInputTokens(record.inputs),
		...extractInputTokens(record.input_modalities),
		...extractInputTokens(record.inputModalities),
		...extractInputTokens(record.supported_modalities),
		...extractInputTokens(record.supportedModalities),
		...extractInputTokens(record.supported_input_modalities),
		...extractInputTokens(record.supportedInputModalities),
		...extractInputTokens(record.capabilities),
		...extractInputTokens(modalities?.input),
		...extractInputTokens(architecture?.input_modalities),
		...extractInputTokens(architecture?.inputModalities),
		...extractInputTokens(architecture?.modality),
		...extractInputTokens(topProvider?.input_modalities),
		...extractInputTokens(topProvider?.inputModalities),
	]);
	return inputs.length > 0 ? inputs : undefined;
}

export function extractRuntimeModelInput(value: unknown): RuntimeModelInputKind[] | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}
	return extractInputsFromRecord(value as Record<string, unknown>);
}

export function resolveRuntimeModelInput(
	config: RuntimeModelsConfig | undefined,
	providerId: string,
	modelId: string,
): RuntimeModelInputKind[] | undefined {
	const provider = config?.providers?.[providerId];
	const entry = provider?.models?.find((candidate) => candidate.id === modelId);
	return normalizeRuntimeModelEntryInput(entry);
}

export function resolveRuntimeModelLimits(input: {
	config?: RuntimeModelsConfig;
	providerId: string;
	modelId: string;
}): RuntimeModelLimits | undefined {
	const provider = input.config?.providers?.[input.providerId];
	const entry = provider?.models?.find((candidate) => candidate.id === input.modelId);
	return normalizeRuntimeModelLimits(entry);
}

export function extractRuntimeModelLimits(value: unknown): RuntimeModelLimits | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const architecture = typeof record.architecture === "object" && record.architecture !== null
		? (record.architecture as Record<string, unknown>)
		: undefined;
	const topProvider = typeof record.top_provider === "object" && record.top_provider !== null
		? (record.top_provider as Record<string, unknown>)
		: undefined;
	const contextWindow = pickPositiveNumber([
		record.contextWindow,
		record.context_window,
		record.context_length,
		record.max_context_length,
		record.max_input_tokens,
		record.maxInputTokens,
		record.inputTokenLimit,
		record.input_token_limit,
		architecture?.context_length,
		topProvider?.context_length,
	]);
	const maxTokens = pickPositiveNumber([
		record.maxTokens,
		record.max_tokens,
		record.max_completion_tokens,
		record.max_output_tokens,
		record.output_token_limit,
		record.outputTokenLimit,
		record.output_token_limit,
		topProvider?.max_completion_tokens,
	]);
	if (contextWindow === undefined && maxTokens === undefined) {
		return undefined;
	}
	return {
		contextWindow,
		maxTokens,
	};
}

export function buildRuntimeModelEntryMetadataFromInput(
	input: string[] | RuntimeModelInputKind[] | undefined,
): Pick<RuntimeModelEntry, "input" | "capabilities"> {
	const normalized = uniqueInputs(input ?? []);
	if (normalized.length === 0) {
		return {};
	}
	return {
		input: normalized,
		capabilities: [
			...(normalized.includes("text") ? ["text"] : []),
			...(normalized.includes("image") ? ["vision"] : []),
		],
	};
}
