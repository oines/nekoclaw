import { complete, type Api, type Context, type Model } from "@mariozechner/pi-ai";
import type { PersonaMemoryManifestEntry } from "./types.js";

const SELECTOR_TIMEOUT_MS = 5_000;
export const SELECTOR_MAX_PATHS = 5;

export interface PersonaMemorySelectorInput {
	senderAccount: string;
	senderDisplayName?: string;
	messageText: string;
	manifest: PersonaMemoryManifestEntry[];
}

export interface PersonaMemorySelectorResult {
	paths: string[];
	raw: string;
}

function extractResponseText(response: Awaited<ReturnType<typeof complete>>): string {
	return response.content
		.filter((block): block is Extract<(typeof response.content)[number], { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

function extractJsonObject(text: string): string {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start === -1 || end === -1 || end <= start) {
		throw new Error(`Selector did not return JSON: ${text}`);
	}
	return text.slice(start, end + 1);
}

function formatAvailableMemoryFiles(manifest: PersonaMemoryManifestEntry[]): string {
	return manifest
		.map((entry) => {
			const summary = [entry.title, entry.description].filter(Boolean).join("，") || "(no description)";
			return `- [${entry.kind}] ${entry.path}: ${summary}`;
		})
		.join("\n");
}

export async function selectRelevantPersonaMemories(
	model: Model<Api>,
	input: PersonaMemorySelectorInput,
	options?: { apiKey?: string },
): Promise<PersonaMemorySelectorResult> {
	const allowedPaths = new Set(input.manifest.map((entry) => entry.path));
	const context: Context = {
		systemPrompt: "你是 Nekoclaw 的记忆选择器，根据当前消息和候选记忆清单，选出最相关的文件。",
		messages: [
			{
				role: "user",
				content: [
					`Current sender: ${input.senderAccount}${input.senderDisplayName ? ` (${input.senderDisplayName})` : ""}`,
					`Message: ${input.messageText}`,
					"Available memory files:",
					formatAvailableMemoryFiles(input.manifest),
					`Select 0-${SELECTOR_MAX_PATHS} most relevant files. Return JSON: {"paths":[...]}`,
				].join("\n\n"),
				timestamp: Date.now(),
			},
		],
	};

	const response = await Promise.race([
		complete(model, context, options?.apiKey ? { apiKey: options.apiKey } : undefined),
		new Promise<never>((_, reject) => {
			setTimeout(() => reject(new Error(`selector timeout after ${SELECTOR_TIMEOUT_MS}ms`)), SELECTOR_TIMEOUT_MS);
		}),
	]);
	const raw = extractResponseText(response);
	const parsed = JSON.parse(extractJsonObject(raw)) as { paths?: unknown };
	const selectedPaths = Array.isArray(parsed.paths) ? parsed.paths : [];
	const paths = Array.from(
		new Set(
			selectedPaths
				.filter((value): value is string => typeof value === "string")
				.filter((value) => allowedPaths.has(value))
				.slice(0, SELECTOR_MAX_PATHS),
		),
	);
	return { paths, raw };
}
