import { describe, expect, it } from "vitest";
import type { WorkerResult } from "../src/types.js";

describe("collectToolActionReplyText", () => {
	it("includes text and attachment summaries from send/reply actions", async () => {
		const { collectToolActionReplyText } = await import("../src/runtime/worker-runner.js");

		const result: WorkerResult = {
			outbound: {},
			toolActions: [
				{
					kind: "reply",
					payload: {
						text: "here is your file",
						attachments: [
							{ kind: "image", name: "photo.png", mimeType: "image/png" },
							{ kind: "file", name: "report.pdf", mimeType: "application/pdf" },
						],
					},
				},
				{
					kind: "send",
					payload: {
						attachments: [{ kind: "image", name: "banner.jpg" }],
					},
				},
			],
		};

		const text = collectToolActionReplyText(result);
		expect(text).toContain("here is your file");
		expect(text).toContain("[image: photo.png]");
		expect(text).toContain("[file: report.pdf]");
		expect(text).toContain("[image: banner.jpg]");
	});

	it("falls back to mimeType when attachment has no name", async () => {
		const { collectToolActionReplyText } = await import("../src/runtime/worker-runner.js");

		const result: WorkerResult = {
			outbound: {},
			toolActions: [
				{
					kind: "reply",
					payload: {
						attachments: [{ kind: "file", mimeType: "application/zip" }],
					},
				},
			],
		};

		const text = collectToolActionReplyText(result);
		expect(text).toContain("[file: application/zip]");
	});

	it("ignores non-send/reply tool actions", async () => {
		const { collectToolActionReplyText } = await import("../src/runtime/worker-runner.js");

		const result: WorkerResult = {
			outbound: {},
			toolActions: [
				{ kind: "typing", payload: {} } as unknown as NonNullable<WorkerResult["toolActions"]>[number],
				{ kind: "reply", payload: { text: "hello" } },
			],
		};

		const text = collectToolActionReplyText(result);
		expect(text).toBe("hello");
	});
});
