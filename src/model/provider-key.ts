import { createHash } from "node:crypto";
import type { ModelApiFormat } from "../types.js";

export const MODEL_ENV_MAP: Record<string, string> = {
	anthropic: "ANTHROPIC_API_KEY",
	openai: "OPENAI_API_KEY",
	"azure-openai-responses": "AZURE_OPENAI_API_KEY",
	google: "GEMINI_API_KEY",
	groq: "GROQ_API_KEY",
	cerebras: "CEREBRAS_API_KEY",
	xai: "XAI_API_KEY",
	openrouter: "OPENROUTER_API_KEY",
	"vercel-ai-gateway": "AI_GATEWAY_API_KEY",
	zai: "ZAI_API_KEY",
	mistral: "MISTRAL_API_KEY",
	minimax: "MINIMAX_API_KEY",
	"minimax-cn": "MINIMAX_CN_API_KEY",
	huggingface: "HF_TOKEN",
	opencode: "OPENCODE_API_KEY",
	"opencode-go": "OPENCODE_API_KEY",
	"kimi-coding": "KIMI_API_KEY",
};

function slugify(input: string): string {
	return input
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

export function normalizeCustomBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim();
	if (!trimmed) {
		return trimmed;
	}
	try {
		const url = new URL(trimmed);
		const pathname = url.pathname.replace(/\/+$/g, "");
		const search = url.search.trim();
		return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${pathname}${search}`;
	} catch {
		return trimmed.replace(/\/+$/g, "");
	}
}

export function getCustomProviderIdentity(baseUrl: string, api: ModelApiFormat): string {
	return `${normalizeCustomBaseUrl(baseUrl)}|${api}`;
}

export function getBaseCustomProviderKey(baseUrl: string, api: ModelApiFormat): string {
	const normalized = normalizeCustomBaseUrl(baseUrl);
	const raw = `${normalized}-${api}`;
	const slug = slugify(raw);
	return `custom-${slug || "provider"}`;
}

export function getCustomProviderKeyHashSuffix(baseUrl: string, api: ModelApiFormat): string {
	return createHash("sha1").update(getCustomProviderIdentity(baseUrl, api)).digest("hex").slice(0, 8);
}

