import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchModelCatalog, fetchProxyModelCatalog } from "../src/model/catalog.js";

describe("model catalog discovery", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("parses openai-compatible model catalogs from upstream payloads", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				json: async () => ({
					data: [
						{
							id: "openrouter/model-a",
							name: "Model A",
							input_modalities: ["text", "image"],
							context_length: 200_000,
							max_completion_tokens: 16_000,
						},
					],
				}),
			})),
		);

		await expect(
			fetchModelCatalog({
				providerId: "openrouter",
				api: "openai-completions",
				baseUrl: "https://openrouter.example/api/v1",
				apiKey: "test-key",
			}),
		).resolves.toEqual([
			{
				id: "openrouter/model-a",
				name: "Model A",
				input: ["text", "image"],
				contextWindow: 200_000,
				maxTokens: 16_000,
				sourceApi: "openai-completions",
				sourceBaseUrl: "https://openrouter.example/api/v1",
			},
		]);
	});

	it("normalizes google model ids from the upstream models/ prefix", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				json: async () => ({
					models: [
						{
							name: "models/gemini-2.5-flash",
							displayName: "Gemini 2.5 Flash",
							inputTokenLimit: 1_048_576,
							outputTokenLimit: 65_535,
						},
					],
				}),
			})),
		);

		await expect(
			fetchModelCatalog({
				providerId: "google",
				api: "google-generative-ai",
				baseUrl: "https://generativelanguage.googleapis.com/v1beta",
				apiKey: "test-key",
			}),
		).resolves.toEqual([
			{
				id: "gemini-2.5-flash",
				name: "Gemini 2.5 Flash",
				contextWindow: 1_048_576,
				maxTokens: 65_535,
				sourceApi: "google-generative-ai",
				sourceBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
			},
		]);
	});

	it("tries multiple catalog protocols for custom providers and returns the first successful one", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce({
				ok: false,
				status: 404,
				text: async () => "not found",
			})
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					data: [{ id: "provider/model-b", name: "Model B" }],
				}),
			});
		vi.stubGlobal("fetch", fetchMock);

		await expect(fetchProxyModelCatalog("https://proxy.example/v1", "test-key")).resolves.toEqual([
			{
				id: "provider/model-b",
				name: "Model B",
				sourceApi: "anthropic-messages",
				sourceBaseUrl: "https://proxy.example/v1",
			},
		]);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});
