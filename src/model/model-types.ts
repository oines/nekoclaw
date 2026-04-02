export interface RuntimeModelEntry {
	id?: string;
	name?: string;
	reasoning?: boolean;
	input?: string[];
	capabilities?: string[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
}

export interface RuntimeModelProvider {
	baseUrl?: string;
	api?: string;
	apiKey?: string;
	authHeader?: boolean;
	compat?: {
		supportsDeveloperRole?: boolean;
		supportsReasoningEffort?: boolean;
	};
	models?: RuntimeModelEntry[];
}

export interface RuntimeModelsConfig extends Record<string, unknown> {
	providers: Record<string, RuntimeModelProvider>;
}
