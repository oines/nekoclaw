import { complete, type Context } from "@mariozechner/pi-ai";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { MODEL_ENV_MAP } from "../../model/provider-key.js";
import type { AgentSpec } from "../../types.js";
import { JsonNekoclawStore } from "../../store/json-store.js";

export interface HarnessReplyJudgeSpec {
	title: string;
	expectations: string[];
	failureSignals: string[];
}

export interface HarnessReplyJudgeResult {
	verdict: "pass" | "fail";
	reason: string;
	raw: string;
}

function extractResponseText(response: Awaited<ReturnType<typeof complete>>): string {
	return response.content
		.filter((block): block is Extract<(typeof response.content)[number], { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

function resolveJudgeModel(store: JsonNekoclawStore, agent: AgentSpec) {
	if (!agent.provider || !agent.modelId) {
		throw new Error(`Agent ${agent.slug} has no configured model for harness judging`);
	}
	const registry = new ModelRegistry(AuthStorage.inMemory(), store.getRuntimeModelsPath(agent.slug));
	const model = registry.find(agent.provider, agent.modelId);
	if (!model) {
		throw new Error(`Could not resolve judge model ${agent.provider}/${agent.modelId}`);
	}
	const modelConfig = store.getModelConfig(agent.agentId);
	const apiKey =
		modelConfig?.kind === "custom"
			? store.getCustomModelApiKey(agent.agentId)
			: store.getProviderKey(agent.agentId, agent.provider) ?? process.env[MODEL_ENV_MAP[agent.provider] ?? ""];
	return { model, apiKey };
}

function extractJsonObject(text: string): string {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start === -1 || end === -1 || end <= start) {
		throw new Error(`Harness judge did not return JSON: ${text}`);
	}
	return text.slice(start, end + 1);
}

export async function judgeHarnessReply(
	store: JsonNekoclawStore,
	agent: AgentSpec,
	input: {
		spec: HarnessReplyJudgeSpec;
		reply: string;
		transcript: string[];
	},
): Promise<HarnessReplyJudgeResult> {
	const { model, apiKey } = resolveJudgeModel(store, agent);
	const context: Context = {
		systemPrompt: [
			"你是 Nekoclaw harness 的严格裁判。",
			"你只根据给定的场景预期、失败信号、bot 最终回复和对话证据来裁决。",
			"不要脑补未给出的事实。",
			"输出必须是 JSON，格式为 {\"verdict\":\"pass|fail\",\"reason\":\"...\"}。",
		].join("\n"),
		messages: [
			{
				role: "user",
				content: [
					`场景：${input.spec.title}`,
					`预期：\n${input.spec.expectations.map((item) => `- ${item}`).join("\n")}`,
					`不通过表现：\n${input.spec.failureSignals.map((item) => `- ${item}`).join("\n")}`,
					`Bot 最终回复：\n${input.reply}`,
					`相关证据：\n${input.transcript.map((line) => `- ${line}`).join("\n")}`,
				].join("\n\n"),
				timestamp: Date.now(),
			},
		],
	};
	const response = await complete(model, context, apiKey ? { apiKey } : undefined);
	const raw = extractResponseText(response);
	const parsed = JSON.parse(extractJsonObject(raw)) as Partial<HarnessReplyJudgeResult>;
	if (parsed.verdict !== "pass" && parsed.verdict !== "fail") {
		throw new Error(`Harness judge returned invalid verdict: ${raw}`);
	}
	return {
		verdict: parsed.verdict,
		reason: parsed.reason?.trim() || "No reason provided",
		raw,
	};
}
