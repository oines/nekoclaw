import { describe, expect, it } from "vitest";
import { buildRuntimeModelEntryMetadata, resolveRuntimeModelInput } from "../src/model/runtime-model-metadata.js";
import type { RuntimeModelsConfig } from "../src/model/model-types.js";

describe("runtime model metadata", () => {
	it("maps legacy capabilities to image input", () => {
		const config: RuntimeModelsConfig = {
			providers: {
				"openrouter-direct": {
					baseUrl: "https://openrouter.ai/api/v1",
					api: "openai-completions",
					models: [
						{
							id: "google/gemini-3.1-flash-lite-preview",
							name: "Gemini 3.1",
							capabilities: ["text", "vision", "tools"],
						},
					],
				},
			},
		};
		expect(resolveRuntimeModelInput(config, "openrouter-direct", "google/gemini-3.1-flash-lite-preview")).toEqual([
			"text",
			"image",
		]);
	});

	it("infers image input for known OpenRouter-compatible custom models", () => {
		const metadata = buildRuntimeModelEntryMetadata({
			providerId: "openrouter-direct",
			provider: {
				baseUrl: "https://openrouter.ai/api/v1",
				api: "openai-completions",
			},
			modelId: "google/gemini-3.1-flash-lite-preview",
		});
		expect(metadata.input).toEqual(["text", "image"]);
		expect(metadata.capabilities).toEqual(["text", "vision"]);
	});
});
