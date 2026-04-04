import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	HarnessScenarioCategory,
	InternalChatHarnessEvidence,
	InternalChatHarnessReport,
	InternalChatHarnessScenarioResult,
} from "../src/internal/chat-harness/current-env.js";

const runInternalChatHarnessMock = vi.fn<
	(args: unknown[]) => Promise<InternalChatHarnessReport & { sandboxPath?: string }>
>();

vi.mock("../src/internal/chat-harness.js", () => ({
	runInternalChatHarness: runInternalChatHarnessMock,
}));

function createEvidence(): InternalChatHarnessEvidence {
	return {
		transcript: [],
		pairs: [],
		queueTail: [],
		auditTail: [],
		sessionLogTail: [],
		sandboxAgentSlug: "sandbox-cat",
	};
}

function createResult(input: {
	name: string;
	channel?: "telegram" | "napcat";
	category: HarnessScenarioCategory;
	status: "passed" | "failed" | "skipped";
	error?: string;
	judgeReason?: string;
}): InternalChatHarnessScenarioResult {
	return {
		name: input.name,
		channel: input.channel ?? "telegram",
		category: input.category,
		status: input.status,
		durationMs: 10,
		error: input.error,
		judge: input.judgeReason
			? {
					verdict: "fail",
					reason: input.judgeReason,
					raw: JSON.stringify({ verdict: "fail", reason: input.judgeReason }),
				}
			: undefined,
		evidence: createEvidence(),
	};
}

describe("persona harness helpers", () => {
	beforeEach(() => {
		vi.resetModules();
		runInternalChatHarnessMock.mockReset();
		runInternalChatHarnessMock.mockResolvedValue({
			ok: true,
			agentRef: "agent-1",
			agentSlug: "agent-1-harness",
			startedAt: "2026-04-04T00:00:00.000Z",
			finishedAt: "2026-04-04T00:01:00.000Z",
			subjectModelRef: "openrouter/google/gemini-3.1-flash-lite-preview",
			judgeModelRef: "openai/gpt-5",
			summary: {
				total: 0,
				passed: 0,
				failed: 0,
				skipped: 0,
				passRate: 1,
				byCategory: {},
				failures: [],
			},
			results: [],
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("builds a category summary with failure reasons", async () => {
		const { buildHarnessSummary } = await import("../src/internal/chat-harness/current-env.js");
		const summary = buildHarnessSummary([
			createResult({ name: "recall-pass", category: "recall", status: "passed" }),
			createResult({ name: "recall-fail", category: "recall", status: "failed", judgeReason: "没有读 detail file" }),
			createResult({ name: "dream-skip", category: "dream", status: "skipped" }),
			createResult({ name: "sedimentation-fail", category: "sedimentation", status: "failed", error: "formation audit timeout" }),
		]);

		expect(summary.total).toBe(4);
		expect(summary.passed).toBe(1);
		expect(summary.failed).toBe(2);
		expect(summary.byCategory.recall).toMatchObject({
			total: 2,
			passed: 1,
			failed: 1,
			skipped: 0,
		});
		expect(summary.byCategory.dream).toMatchObject({
			total: 1,
			skipped: 1,
		});
		expect(summary.failures).toEqual([
			{
				name: "recall-fail",
				channel: "telegram",
				category: "recall",
				reason: "没有读 detail file",
			},
			{
				name: "sedimentation-fail",
				channel: "telegram",
				category: "sedimentation",
				reason: "formation audit timeout",
			},
		]);
	});

	it("runs persona benchmark with the full persona scenario set and judge override", async () => {
		const { PERSONA_HARNESS_SCENARIOS, runPersonaBenchmark } = await import("../src/internal/persona-harness.js");

		await runPersonaBenchmark({
			agentRef: "worker-agent",
			judgeAgentRef: "judge-agent",
			channel: "telegram",
		});

		expect(runInternalChatHarnessMock).toHaveBeenCalledTimes(1);
		expect(runInternalChatHarnessMock).toHaveBeenCalledWith({
			agentRef: "worker-agent",
			judgeAgentRef: "judge-agent",
			channel: "telegram",
			scenario: [...PERSONA_HARNESS_SCENARIOS],
			judgeReplies: true,
		});
		expect(PERSONA_HARNESS_SCENARIOS).toContain("persona_detail_file_recall");
		expect(PERSONA_HARNESS_SCENARIOS).toContain("persona_run_transcript_persistence");
	});
});
