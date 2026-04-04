import { describe, expect, it } from "vitest";
import {
	buildRuntimeModelEntryMetadataFromInput,
	extractRuntimeModelInput,
	extractRuntimeModelLimits,
	resolveRuntimeModelInput,
} from "../src/model/runtime-model-metadata.js";
import type { RuntimeModelsConfig } from "../src/model/model-types.js";

describe("runtime model metadata", () => {
	it("maps legacy capabilities to image input from persisted runtime entries", () => {
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

	it("extracts image input from upstream model payloads without relying on model ids", () => {
		expect(
			extractRuntimeModelInput({
				id: "provider/model",
				architecture: {
					modality: "text+image->text",
				},
			}),
		).toEqual(["text", "image"]);
	});

	it("extracts token limits and builds capabilities from explicit upstream metadata", () => {
		expect(
			extractRuntimeModelLimits({
				id: "models/gemini-2.5-flash",
				inputTokenLimit: 1_048_576,
				outputTokenLimit: 65_535,
			}),
		).toEqual({
			contextWindow: 1_048_576,
			maxTokens: 65_535,
		});
		expect(buildRuntimeModelEntryMetadataFromInput(["text", "image"])).toEqual({
			input: ["text", "image"],
			capabilities: ["text", "vision"],
		});
	});
});
