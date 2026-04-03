import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { ModelApiFormat } from "./common.js";

export interface BuiltinModelConfig {
	kind: "builtin";
	provider: string;
	modelId: string;
	apiKey?: string;
	thinkingLevel?: ThinkingLevel;
}

export interface CustomModelConfig {
	kind: "custom";
	baseUrl: string;
	api: ModelApiFormat;
	providerId: string;
	modelId: string;
	apiKey?: string;
	thinkingLevel?: ThinkingLevel;
}

export type ModelConfig = BuiltinModelConfig | CustomModelConfig;

export interface ProxyProbeResult {
	api: ModelApiFormat;
	baseUrl: string;
	modelId: string;
	modelsCheckOk: boolean;
	generationCheckOk: boolean;
	details: string[];
}
