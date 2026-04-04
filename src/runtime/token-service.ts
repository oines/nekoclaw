import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { NEKOCLAW_CUSTOM_MODEL_API_KEY_ENV } from "../config.js";
import type { RuntimeModelsConfig } from "../model/model-types.js";
import { fetchProxyModelCatalog, upsertRuntimeModelsConfig } from "../model/probe.js";
import { MODEL_ENV_MAP } from "../model/provider-key.js";
import { resolveRuntimeModelLimits } from "../model/runtime-model-metadata.js";
import type { JsonNekoclawStore } from "../store/json-store.js";
import type { AgentSpec, ModelConfig, SessionRecord } from "../types.js";

export interface TokenCountAvailable {
	available: true;
	tokens: number;
}

export interface TokenCountUnavailable {
	available: false;
	reason:
		| "no_model"
		| "unsupported_model"
		| "missing_api_key"
		| "missing_base_url"
		| "counter_failed";
	error?: string;
}

export type TokenCountResult = TokenCountAvailable | TokenCountUnavailable;

export interface ResolvedTokenModel {
	provider: string;
	modelId: string;
	api?: string;
	baseUrl?: string;
	contextWindow?: number;
	maxTokens?: number;
	apiKey?: string;
	hasPersistedContextWindow?: boolean;
}

type TokenStore = Pick<
	JsonNekoclawStore,
	| "getRuntimeModelsPath"
	| "getModelConfig"
	| "getCustomModelApiKey"
	| "getProviderKey"
	| "readRuntimeModelsConfig"
	| "writeRuntimeModelsConfig"
>;

function trimTrailingSlash(value: string | undefined): string | undefined {
	return value?.replace(/\/+$/, "");
}

function isGeminiModel(modelId: string): boolean {
	return /^gemini(?:-|$)/i.test(modelId);
}

function buildAnthropicCountUrl(baseUrl: string): string {
	return /\/v1$/i.test(baseUrl) ? `${baseUrl}/messages/count_tokens` : `${baseUrl}/v1/messages/count_tokens`;
}

function buildOpenAiResponsesCountUrl(baseUrl: string): string {
	return `${baseUrl}/responses/input_tokens`;
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class TokenService {
	private readonly tokenCountCache = new Map<string, number>();

	private readonly geminiTokenizerCache = new Map<string, Promise<{ countTokens(contents: string): Promise<{ totalTokens?: number }> }>>();

	private readonly metadataRefreshCache = new Map<string, Promise<ResolvedTokenModel | undefined>>();

	constructor(private readonly store: TokenStore) {}

	resolveEffectiveModel(agent: Pick<AgentSpec, "agentId" | "slug" | "provider" | "modelId">, session?: Pick<SessionRecord, "modelOverride">): ResolvedTokenModel | undefined {
		const provider = session?.modelOverride?.provider ?? agent.provider;
		const modelId = session?.modelOverride?.modelId ?? agent.modelId;
		if (!provider || !modelId) {
			return undefined;
		}
		const registry = new ModelRegistry(AuthStorage.inMemory(), this.store.getRuntimeModelsPath(agent.slug));
		const resolved = registry.find(provider, modelId);
		const modelConfig = this.store.getModelConfig(agent.agentId);
		const runtimeConfig = this.store.readRuntimeModelsConfig(agent.agentId) as RuntimeModelsConfig | undefined;
		const runtimeProvider = runtimeConfig?.providers?.[provider];
		const runtimeEntry = runtimeProvider?.models?.find((entry) => entry.id === modelId);
		const fallbackLimits = resolveRuntimeModelLimits({
			config: runtimeConfig,
			providerId: provider,
			modelId,
			api: resolved?.api ?? (modelConfig?.kind === "custom" && modelConfig.providerId === provider ? modelConfig.api : undefined),
			baseUrl:
				trimTrailingSlash(resolved?.baseUrl) ??
				(modelConfig?.kind === "custom" && modelConfig.providerId === provider ? trimTrailingSlash(modelConfig.baseUrl) : undefined),
		});
		const apiKey =
			modelConfig?.kind === "custom"
				? this.store.getCustomModelApiKey(agent.agentId)
				: this.store.getProviderKey(agent.agentId, provider) ?? process.env[MODEL_ENV_MAP[provider] ?? ""];
		return {
			provider,
			modelId,
			api: resolved?.api ?? (modelConfig?.kind === "custom" && modelConfig.providerId === provider ? modelConfig.api : undefined),
			baseUrl:
				trimTrailingSlash(resolved?.baseUrl) ??
				(modelConfig?.kind === "custom" && modelConfig.providerId === provider ? trimTrailingSlash(modelConfig.baseUrl) : undefined),
			contextWindow: runtimeEntry?.contextWindow ?? resolved?.contextWindow ?? fallbackLimits?.contextWindow,
			maxTokens: runtimeEntry?.maxTokens ?? (resolved as { maxTokens?: number } | undefined)?.maxTokens ?? fallbackLimits?.maxTokens,
			apiKey,
			hasPersistedContextWindow: typeof runtimeEntry?.contextWindow === "number" && runtimeEntry.contextWindow > 0,
		};
	}

	async resolveEffectiveModelWithContext(
		agent: Pick<AgentSpec, "agentId" | "slug" | "provider" | "modelId">,
		session?: Pick<SessionRecord, "modelOverride">,
	): Promise<ResolvedTokenModel | undefined> {
		const resolved = this.resolveEffectiveModel(agent, session);
		if (!resolved) {
			return undefined;
		}
		if (resolved.contextWindow && resolved.hasPersistedContextWindow) {
			return resolved;
		}
		return (await this.refreshContextMetadata(agent, session, resolved)) ?? resolved;
	}

	async countText(model: ResolvedTokenModel | undefined, text: string): Promise<TokenCountResult> {
		if (!model) {
			return { available: false, reason: "no_model" };
		}
		if (text.length === 0) {
			return { available: true, tokens: 0 };
		}
		const cacheKey = `${model.provider}|${model.modelId}|${model.api ?? ""}|${text}`;
		const cached = this.tokenCountCache.get(cacheKey);
		if (cached !== undefined) {
			return { available: true, tokens: cached };
		}
		try {
			const tokens = await this.countTextInternal(model, text);
			this.tokenCountCache.set(cacheKey, tokens);
			return { available: true, tokens };
		} catch (error) {
			return {
				available: false,
				reason:
					error instanceof TokenCounterConfigurationError ? error.reason : "counter_failed",
				error: getErrorMessage(error),
			};
		}
	}

	private async countTextInternal(model: ResolvedTokenModel, text: string): Promise<number> {
		if (this.shouldUseGeminiLocalTokenizer(model)) {
			return await this.countWithGeminiTokenizer(model.modelId, text);
		}
		if (model.api === "anthropic-messages") {
			return await this.countWithAnthropicApi(model, text);
		}
		if (model.api === "openai-responses") {
			return await this.countWithOpenAiResponsesApi(model, text);
		}
		throw new TokenCounterConfigurationError("unsupported_model");
	}

	private async refreshContextMetadata(
		agent: Pick<AgentSpec, "agentId" | "slug" | "provider" | "modelId">,
		session: Pick<SessionRecord, "modelOverride"> | undefined,
		resolved: ResolvedTokenModel,
	): Promise<ResolvedTokenModel | undefined> {
		const modelConfig = this.store.getModelConfig(agent.agentId);
		if (!this.canRefreshCustomContextMetadata(modelConfig, resolved)) {
			return undefined;
		}
		const cacheKey = `${agent.agentId}|${resolved.provider}|${resolved.modelId}`;
		let refreshPromise = this.metadataRefreshCache.get(cacheKey);
		if (!refreshPromise) {
			refreshPromise = this.refreshContextMetadataInternal(agent, session, resolved, modelConfig);
			this.metadataRefreshCache.set(cacheKey, refreshPromise);
		}
		try {
			return await refreshPromise;
		} finally {
			this.metadataRefreshCache.delete(cacheKey);
		}
	}

	private canRefreshCustomContextMetadata(
		modelConfig: ModelConfig | undefined,
		resolved: ResolvedTokenModel,
	): modelConfig is Extract<ModelConfig, { kind: "custom" }> {
		return Boolean(
			modelConfig?.kind === "custom" &&
			modelConfig.providerId === resolved.provider &&
			resolved.api === "openai-completions" &&
			resolved.baseUrl,
		);
	}

	private async refreshContextMetadataInternal(
		agent: Pick<AgentSpec, "agentId" | "slug" | "provider" | "modelId">,
		_session: Pick<SessionRecord, "modelOverride"> | undefined,
		resolved: ResolvedTokenModel,
		modelConfig: Extract<ModelConfig, { kind: "custom" }>,
	): Promise<ResolvedTokenModel | undefined> {
		try {
			const catalog = await fetchProxyModelCatalog(resolved.baseUrl!, resolved.apiKey);
			const entry = catalog.find((candidate) => candidate.id === resolved.modelId);
			if (!entry || (entry.contextWindow === undefined && entry.maxTokens === undefined && !entry.name)) {
				return undefined;
			}
			const current = this.store.readRuntimeModelsConfig(agent.agentId) as RuntimeModelsConfig | undefined;
			const updated = upsertRuntimeModelsConfig(current, {
				baseUrl: modelConfig.baseUrl,
				api: modelConfig.api,
				provider: modelConfig.providerId,
				apiKeyEnv: NEKOCLAW_CUSTOM_MODEL_API_KEY_ENV,
				modelId: resolved.modelId,
				name: entry.name,
				contextWindow: entry.contextWindow,
				maxTokens: entry.maxTokens,
			});
			this.store.writeRuntimeModelsConfig(agent.agentId, updated, {
				source: "context-window-refresh",
				providerId: modelConfig.providerId,
				modelId: resolved.modelId,
			});
			return this.resolveEffectiveModel(agent, _session);
		} catch {
			return undefined;
		}
	}

	private shouldUseGeminiLocalTokenizer(model: ResolvedTokenModel): boolean {
		return (
			(model.api === "google-generative-ai" || model.api === "google-vertex" || model.api === "google-gemini-cli") &&
			isGeminiModel(model.modelId)
		);
	}

	private async countWithGeminiTokenizer(modelId: string, text: string): Promise<number> {
		let tokenizerPromise = this.geminiTokenizerCache.get(modelId);
		if (!tokenizerPromise) {
			tokenizerPromise = import("@google/genai/tokenizer").then(
				(module) => new module.LocalTokenizer(modelId),
			);
			this.geminiTokenizerCache.set(modelId, tokenizerPromise);
		}
		const tokenizer = await tokenizerPromise;
		const result = await tokenizer.countTokens(text);
		return result.totalTokens ?? 0;
	}

	private async countWithAnthropicApi(model: ResolvedTokenModel, text: string): Promise<number> {
		if (!model.apiKey) {
			throw new TokenCounterConfigurationError("missing_api_key");
		}
		if (!model.baseUrl) {
			throw new TokenCounterConfigurationError("missing_base_url");
		}
		const response = await fetch(buildAnthropicCountUrl(model.baseUrl), {
			method: "POST",
			headers: {
				"x-api-key": model.apiKey,
				"anthropic-version": "2023-06-01",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: model.modelId,
				messages: [{ role: "user", content: text }],
			}),
		});
		if (!response.ok) {
			throw new Error(`Anthropic token count failed with ${response.status}: ${await response.text()}`);
		}
		const payload = (await response.json()) as { input_tokens?: number };
		if (typeof payload.input_tokens !== "number") {
			throw new Error("Anthropic token count response is missing input_tokens");
		}
		return payload.input_tokens;
	}

	private async countWithOpenAiResponsesApi(model: ResolvedTokenModel, text: string): Promise<number> {
		if (!model.apiKey) {
			throw new TokenCounterConfigurationError("missing_api_key");
		}
		if (!model.baseUrl) {
			throw new TokenCounterConfigurationError("missing_base_url");
		}
		const response = await fetch(buildOpenAiResponsesCountUrl(model.baseUrl), {
			method: "POST",
			headers: {
				authorization: `Bearer ${model.apiKey}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: model.modelId,
				input: text,
				truncation: "disabled",
			}),
		});
		if (!response.ok) {
			throw new Error(`OpenAI token count failed with ${response.status}: ${await response.text()}`);
		}
		const payload = (await response.json()) as { input_tokens?: number };
		if (typeof payload.input_tokens !== "number") {
			throw new Error("OpenAI token count response is missing input_tokens");
		}
		return payload.input_tokens;
	}
}

class TokenCounterConfigurationError extends Error {
	constructor(public readonly reason: TokenCountUnavailable["reason"]) {
		super(reason);
	}
}
