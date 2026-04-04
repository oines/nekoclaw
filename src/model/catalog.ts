import { getModels } from "@mariozechner/pi-ai";
import type { ModelApiFormat } from "../types.js";
import { extractRuntimeModelInput, extractRuntimeModelLimits, type RuntimeModelInputKind } from "./runtime-model-metadata.js";

export interface RuntimeModelCatalogTarget {
	providerId: string;
	api: ModelApiFormat;
	baseUrl: string;
	apiKey?: string;
	authHeader?: boolean;
	headers?: Record<string, string>;
}

export interface DiscoveredRuntimeModelEntry {
	id: string;
	name?: string;
	input?: RuntimeModelInputKind[];
	contextWindow?: number;
	maxTokens?: number;
	sourceApi?: ModelApiFormat;
	sourceBaseUrl?: string;
}

function trimTrailingSlash(value: string): string {
	return value.replace(/\/+$/, "");
}

function getString(record: Record<string, unknown>, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim().length > 0) {
			return value.trim();
		}
	}
	return undefined;
}

function normalizeListedModelId(value: string | undefined): string | undefined {
	if (!value) {
		return undefined;
	}
	return value.startsWith("models/") ? value.slice("models/".length) : value;
}

function buildModelCatalogUrl(target: RuntimeModelCatalogTarget): string | undefined {
	const normalized = trimTrailingSlash(target.baseUrl);
	switch (target.api) {
		case "openai-completions":
		case "openai-responses":
		case "openai-codex-responses":
		case "azure-openai-responses":
			return `${normalized}/models`;
		case "anthropic-messages":
		case "mistral-conversations":
			return /\/v1$/i.test(normalized) ? `${normalized}/models` : `${normalized}/v1/models`;
		case "google-generative-ai":
		case "google-gemini-cli":
		case "google-vertex":
			return `${normalized}/models`;
		default:
			return undefined;
	}
}

function buildModelCatalogHeaders(target: RuntimeModelCatalogTarget): Record<string, string> {
	const headers: Record<string, string> = { ...(target.headers ?? {}) };
	switch (target.api) {
		case "openai-completions":
		case "openai-responses":
		case "openai-codex-responses":
		case "azure-openai-responses":
		case "mistral-conversations":
			if (target.apiKey) {
				headers.authorization = `Bearer ${target.apiKey}`;
			}
			break;
		case "anthropic-messages":
			if (target.apiKey) {
				headers["x-api-key"] = target.apiKey;
			}
			headers["anthropic-version"] = headers["anthropic-version"] ?? "2023-06-01";
			break;
		case "google-generative-ai":
		case "google-gemini-cli":
		case "google-vertex":
			if (target.apiKey) {
				headers["x-goog-api-key"] = target.apiKey;
			}
			break;
	}
	return headers;
}

function withOptionalGoogleApiKey(url: string, target: RuntimeModelCatalogTarget): string {
	if (
		(target.api !== "google-generative-ai" && target.api !== "google-gemini-cli" && target.api !== "google-vertex") ||
		!target.apiKey
	) {
		return url;
	}
	const parsed = new URL(url);
	if (!parsed.searchParams.has("key")) {
		parsed.searchParams.set("key", target.apiKey);
	}
	return parsed.toString();
}

function getCatalogItems(payload: unknown): unknown[] {
	if (Array.isArray(payload)) {
		return payload;
	}
	if (!payload || typeof payload !== "object") {
		return [];
	}
	const record = payload as Record<string, unknown>;
	if (Array.isArray(record.data)) {
		return record.data;
	}
	if (Array.isArray(record.models)) {
		return record.models;
	}
	if (Array.isArray(record.items)) {
		return record.items;
	}
	return [];
}

function extractDiscoveredRuntimeModelEntry(
	value: unknown,
	target: RuntimeModelCatalogTarget,
): DiscoveredRuntimeModelEntry | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const id =
		normalizeListedModelId(getString(record, ["id", "modelId", "model_id", "model"])) ??
		normalizeListedModelId(getString(record, ["name"]));
	if (!id) {
		return undefined;
	}
	const rawName = getString(record, ["display_name", "displayName", "title", "name"]);
	const name = rawName && normalizeListedModelId(rawName) !== id ? rawName : undefined;
	const limits = extractRuntimeModelLimits(record);
	const input = extractRuntimeModelInput(record);
	return {
		id,
		name,
		input,
		contextWindow: limits?.contextWindow,
		maxTokens: limits?.maxTokens,
		sourceApi: target.api,
		sourceBaseUrl: trimTrailingSlash(target.baseUrl),
	};
}

function mergeDiscoveredEntries(
	left: DiscoveredRuntimeModelEntry,
	right: DiscoveredRuntimeModelEntry,
): DiscoveredRuntimeModelEntry {
	return {
		id: left.id,
		name: left.name ?? right.name,
		input: left.input?.length ? left.input : right.input,
		contextWindow: left.contextWindow ?? right.contextWindow,
		maxTokens: left.maxTokens ?? right.maxTokens,
		sourceApi: left.sourceApi ?? right.sourceApi,
		sourceBaseUrl: left.sourceBaseUrl ?? right.sourceBaseUrl,
	};
}

export async function fetchModelCatalog(target: RuntimeModelCatalogTarget): Promise<DiscoveredRuntimeModelEntry[]> {
	const url = buildModelCatalogUrl(target);
	if (!url) {
		return [];
	}
	const response = await fetch(withOptionalGoogleApiKey(url, target), {
		headers: buildModelCatalogHeaders(target),
	});
	if (!response.ok) {
		throw new Error(`GET ${url} failed with ${response.status}: ${await response.text()}`);
	}
	const payload = await response.json();
	return getCatalogItems(payload)
		.map((entry) => extractDiscoveredRuntimeModelEntry(entry, target))
		.filter((entry): entry is DiscoveredRuntimeModelEntry => Boolean(entry));
}

export async function fetchProxyModelCatalog(baseUrl: string, apiKey: string | undefined): Promise<DiscoveredRuntimeModelEntry[]> {
	const attempts: RuntimeModelCatalogTarget[] = [
		{ providerId: "custom", api: "openai-completions", baseUrl, apiKey, authHeader: true },
		{ providerId: "custom", api: "anthropic-messages", baseUrl, apiKey },
		{ providerId: "custom", api: "google-generative-ai", baseUrl, apiKey },
		{ providerId: "custom", api: "mistral-conversations", baseUrl, apiKey },
	];
	for (const attempt of attempts) {
		try {
			const entries = await fetchModelCatalog(attempt);
			if (entries.length > 0) {
				return entries;
			}
		} catch {
			// Ignore and continue trying the next catalog shape.
		}
	}
	return [];
}

export function getBuiltinProviderCatalogTargets(
	providerId: string,
	apiKey: string | undefined,
): RuntimeModelCatalogTarget[] {
	const seen = new Set<string>();
	const targets: RuntimeModelCatalogTarget[] = [];
	for (const model of getModels(providerId as never)) {
		if (!model.baseUrl) {
			continue;
		}
		const key = JSON.stringify([
			model.api,
			trimTrailingSlash(model.baseUrl),
			model.headers ?? {},
			Boolean((model as { authHeader?: boolean }).authHeader),
		]);
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		targets.push({
			providerId,
			api: model.api,
			baseUrl: trimTrailingSlash(model.baseUrl),
			apiKey,
			headers: (model as { headers?: Record<string, string> }).headers,
			authHeader: (model as { authHeader?: boolean }).authHeader,
		});
	}
	return targets;
}

export async function fetchBuiltinModelCatalog(
	providerId: string,
	apiKey: string | undefined,
): Promise<DiscoveredRuntimeModelEntry[]> {
	const merged = new Map<string, DiscoveredRuntimeModelEntry>();
	for (const target of getBuiltinProviderCatalogTargets(providerId, apiKey)) {
		try {
			for (const entry of await fetchModelCatalog(target)) {
				const current = merged.get(entry.id);
				merged.set(entry.id, current ? mergeDiscoveredEntries(current, entry) : entry);
			}
		} catch {
			// Ignore per-target discovery failures and keep any successful catalogs.
		}
	}
	return Array.from(merged.values()).sort((left, right) => left.id.localeCompare(right.id));
}
