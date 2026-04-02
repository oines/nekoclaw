import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentEnvHarnessContext } from "../src/internal/chat-harness/current-env.js";
import type { RunJob, WorkerResult } from "../src/types.js";

function extractText(job: RunJob): string {
	return job.event.blocks
		.filter((block): block is Extract<(typeof job.event.blocks)[number], { kind: "text" }> => block.kind === "text")
		.map((block) => block.text)
		.join("\n");
}

describe("internal chat harness", () => {
	let tempHome: string;
	const originalHome = process.env.HOME;

	beforeEach(() => {
		tempHome = mkdtempSync(join(tmpdir(), "nekoclaw-chat-harness-test-"));
		process.env.HOME = tempHome;
		vi.resetModules();
	});

	afterEach(() => {
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		rmSync(tempHome, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("runs representative harness scenarios with stubbed worker execution for telegram and napcat", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { runChatHarnessInCurrentEnvironment } = await import("../src/internal/chat-harness/current-env.js");

		const store = new JsonNekoclawStore();
		const agent = store.createAgent({ slug: "harness-cat" });
		store.setBuiltinModelConfig(agent.agentId, {
			provider: "openai",
			modelId: "gpt-5",
			apiKey: "test-key",
		});

		const memory = new Map<string, string>();
		const executeJob = async (job: RunJob, context: CurrentEnvHarnessContext): Promise<WorkerResult> => {
			const text = extractText(job);
			if (text.includes("Remember this codeword for later:")) {
				const match = text.match(/NEKO-ALPHA-\d+/);
				if (match) {
					memory.set(job.sessionRecordId, match[0]);
					return { outbound: { text: `remembered ${match[0]}` } };
				}
			}
			if (text.includes("What codeword did I ask you to remember?")) {
				return { outbound: { text: memory.get(job.sessionRecordId) ?? "UNKNOWN" } };
			}
			if (text.includes("Remember this codeword: RESET-ME-188")) {
				memory.set(job.sessionRecordId, "RESET-ME-188");
				return { outbound: { text: "remembered RESET-ME-188" } };
			}
			if (text.includes("Reply with exactly: HARNESS_OK")) {
				return { outbound: { text: "HARNESS_OK" } };
			}
			if (text.includes("say HARNESS_GROUP_OK")) {
				return { outbound: { text: "HARNESS_GROUP_OK" } };
			}
			if (text.includes("prime the thread")) {
				return { outbound: { text: "thread primed" } };
			}
			if (text.includes("reply path should work")) {
				return { outbound: { text: "reply works" } };
			}
			if (text.includes("Say paired")) {
				return { outbound: { text: "paired" } };
			}
			if (text.includes("What is the dominant color in this image? Reply with exactly: RED")) {
				const imageBlock = job.event.blocks.find((block): block is Extract<(typeof job.event.blocks)[number], { kind: "image" }> => block.kind === "image");
				expect(imageBlock?.attachment?.relativePath).toBeTruthy();
				const imagePath = join(context.workspaceRoot, imageBlock!.attachment!.relativePath);
				expect(existsSync(imagePath)).toBe(true);
				expect(readFileSync(imagePath).byteLength).toBeGreaterThan(0);
				return { outbound: { text: "RED" } };
			}
			if (text.includes("You received two solid-color images in one message. Reply with exactly: RED,BLUE")) {
				const imageBlocks = job.event.blocks.filter((block): block is Extract<(typeof job.event.blocks)[number], { kind: "image" }> => block.kind === "image");
				expect(imageBlocks).toHaveLength(2);
				for (const block of imageBlocks) {
					expect(block.attachment?.relativePath).toBeTruthy();
					const imagePath = join(context.workspaceRoot, block.attachment!.relativePath);
					expect(existsSync(imagePath)).toBe(true);
					expect(readFileSync(imagePath).byteLength).toBeGreaterThan(0);
				}
				return { outbound: { text: "RED,BLUE" } };
			}
			if (text.includes("Describe the scene in one short English sentence. Mention TREE, HOUSE, and SUN only if they are actually visible.")) {
				const imageBlock = job.event.blocks.find((block): block is Extract<(typeof job.event.blocks)[number], { kind: "image" }> => block.kind === "image");
				expect(imageBlock?.attachment?.relativePath).toBeTruthy();
				const imagePath = join(context.workspaceRoot, imageBlock!.attachment!.relativePath);
				expect(existsSync(imagePath)).toBe(true);
				expect(readFileSync(imagePath).byteLength).toBeGreaterThan(100);
				return { outbound: { text: "A TREE stands near a HOUSE under the SUN." } };
			}
			if (text.includes("复述这张图片的内容。先直接说画面里有什么")) {
				const imageBlock = job.event.blocks.find((block): block is Extract<(typeof job.event.blocks)[number], { kind: "image" }> => block.kind === "image");
				expect(imageBlock?.attachment?.relativePath).toBeTruthy();
				const imagePath = join(context.workspaceRoot, imageBlock!.attachment!.relativePath);
				expect(existsSync(imagePath)).toBe(true);
				expect(readFileSync(imagePath).byteLength).toBeGreaterThan(100);
				return { outbound: { text: "画面里有一棵树、一栋房子和太阳。" } };
			}
			if (text.includes("Open the attached file and reply with the secret word only.")) {
				const fileBlock = job.event.blocks.find((block): block is Extract<(typeof job.event.blocks)[number], { kind: "file" }> => block.kind === "file");
				expect(fileBlock?.attachment?.relativePath).toBeTruthy();
				const filePath = join(context.workspaceRoot, fileBlock!.attachment!.relativePath);
				expect(readFileSync(filePath, "utf-8")).toBe("HARNESS_FILE_SECRET_731\n");
				const imageFixture = context.createWorkspaceFixture({
					relativePath: "generated/outbound-vision.png",
					bytes: Buffer.from([9, 8, 7]),
				});
				const fileFixture = context.createWorkspaceFixture({
					relativePath: "generated/outbound-note.txt",
					bytes: Buffer.from("outbound attachment\n", "utf-8"),
				});
				return {
					outbound: {
						text: "HARNESS_FILE_SECRET_731",
						attachments: [
							{ kind: "image", filePath: imageFixture.containerPath, name: "outbound-vision.png" },
							{ kind: "file", filePath: fileFixture.containerPath, name: "outbound-note.txt" },
						],
					},
				};
			}
			if (text.includes("Open both attached files and reply with both secrets in order separated by a comma only.")) {
				const fileBlocks = job.event.blocks.filter((block): block is Extract<(typeof job.event.blocks)[number], { kind: "file" }> => block.kind === "file");
				expect(fileBlocks).toHaveLength(2);
				const contents = fileBlocks.map((block) => readFileSync(join(context.workspaceRoot, block.attachment!.relativePath), "utf-8"));
				expect(contents).toEqual(["HARNESS_FILE_SECRET_731\n", "HARNESS_FILE_SECRET_992\n"]);
				return {
					outbound: {
						text: "HARNESS_FILE_SECRET_731,HARNESS_FILE_SECRET_992",
					},
				};
			}
			if (text.includes("This is a synthetic benchmark image. Read the exact uppercase text printed on the red octagonal road sign. Reply with the sign text only, preserving spaces, and do not add any extra words.")) {
				const imageBlock = job.event.blocks.find((block): block is Extract<(typeof job.event.blocks)[number], { kind: "image" }> => block.kind === "image");
				expect(imageBlock?.attachment?.relativePath).toBeTruthy();
				const imagePath = join(context.workspaceRoot, imageBlock!.attachment!.relativePath);
				expect(existsSync(imagePath)).toBe(true);
				expect(readFileSync(imagePath).byteLength).toBeGreaterThan(100);
				return { outbound: { text: "STOP" } };
			}
			return { outbound: { text: "stub response" } };
		};

		const report = await runChatHarnessInCurrentEnvironment({
			agentRef: agent.agentId,
			channel: "both",
			timeoutMs: 5_000,
			scenario: [
				"dm_pair_prompt",
				"admin_model_session_override",
				"dm_image_vision",
				"dm_multi_image_vision",
				"dm_natural_image_description",
				"dm_natural_image_restate_cn",
				"dm_file_attachment",
				"dm_multi_file_attachment",
				"dm_image_text_mixed",
			],
			executeJob,
		});

		expect(report.ok).toBe(true);
		expect(report.results).toHaveLength(18);
		expect(report.results.every((result) => result.status === "passed")).toBe(true);
		expect(report.results.some((result) => result.channel === "telegram")).toBe(true);
		expect(report.results.some((result) => result.channel === "napcat")).toBe(true);
		for (const channel of ["telegram", "napcat"] as const) {
			const mediaResult = report.results.find((result) => result.channel === channel && result.name === "dm_file_attachment");
			expect(mediaResult?.evidence.transcript.some((entry) => entry.kind === "outbound" && entry.attachments?.some((attachment) => attachment.kind === "image"))).toBe(true);
			expect(mediaResult?.evidence.transcript.some((entry) => entry.kind === "outbound" && entry.attachments?.some((attachment) => attachment.kind === "file"))).toBe(true);
		}
		}, 20_000);
	});
