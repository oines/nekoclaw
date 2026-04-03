import { describe, expect, it } from "vitest";
import type { WorkerResult } from "../src/types.js";

describe("buildFormationTurnTranscript", () => {
	it("includes the inbound turn plus all visible current-session bot outputs", async () => {
		const { buildFormationTurnTranscript } = await import("../src/runtime/worker-runner.js");

		const result: WorkerResult = {
			outbound: {
				text: "final visible reply",
				attachments: [{ kind: "file", name: "summary.txt" }],
			},
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
				{
					kind: "send_targeted",
					target: "telegram:dm:111",
					payload: {
						text: "same session targeted note",
					},
				},
			],
		};

		const transcript = buildFormationTurnTranscript(
			{
				event: {
					eventType: "message.created",
					channelType: "telegram",
					chatId: "111",
					chatKind: "dm",
					messageId: "m1",
					sender: { externalId: "u1", displayName: "Alice" },
					blocks: [{ kind: "text", text: "please remember this promise" }],
					occurredAt: "2026-04-04T00:00:00.000Z",
				},
			},
			{
				channelType: "telegram",
				chatKind: "dm",
				externalConversationId: "111",
			},
			result,
		);

		expect(transcript).toContain("User:\n- Text: please remember this promise");
		expect(transcript).toContain("Bot:\n- Text: here is your file");
		expect(transcript).toContain("- Image: photo.png");
		expect(transcript).toContain("- File: report.pdf");
		expect(transcript).toContain("Bot:\n- Image: banner.jpg");
		expect(transcript).toContain("Bot:\n- Text: same session targeted note");
		expect(transcript).toContain("Bot:\n- Text: final visible reply");
		expect(transcript).toContain("- File: summary.txt");
	});

	it("falls back to mimeType and ignores non-current-session visible actions", async () => {
		const { buildFormationTurnTranscript } = await import("../src/runtime/worker-runner.js");

		const result: WorkerResult = {
			outbound: {},
			toolActions: [
				{
					kind: "reply",
					payload: {
						attachments: [{ kind: "file", mimeType: "application/zip" }],
					},
				},
				{
					kind: "send_targeted",
					target: "telegram:group:999",
					payload: {
						text: "other room",
					},
				},
				{ kind: "typing" } as unknown as NonNullable<WorkerResult["toolActions"]>[number],
			],
		};

		const transcript = buildFormationTurnTranscript(
			{
				event: {
					eventType: "message.created",
					channelType: "telegram",
					chatId: "111",
					chatKind: "dm",
					messageId: "m1",
					sender: { externalId: "u1" },
					blocks: [{ kind: "text", text: "hello" }],
					occurredAt: "2026-04-04T00:00:00.000Z",
				},
			},
			{
				channelType: "telegram",
				chatKind: "dm",
				externalConversationId: "111",
			},
			result,
		);

		expect(transcript).toContain("- File: application/zip");
		expect(transcript).not.toContain("other room");
	});

	it("does not duplicate the final outbound turn when it matches a current-session tool action", async () => {
		const { buildFormationTurnTranscript } = await import("../src/runtime/worker-runner.js");

		const result: WorkerResult = {
			outbound: { text: "hello" },
			toolActions: [
				{ kind: "reply", payload: { text: "hello" } },
			],
		};

		const transcript = buildFormationTurnTranscript(
			{
				event: {
					eventType: "message.created",
					channelType: "telegram",
					chatId: "111",
					chatKind: "dm",
					messageId: "m1",
					sender: { externalId: "u1" },
					blocks: [{ kind: "text", text: "hello" }],
					occurredAt: "2026-04-04T00:00:00.000Z",
				},
			},
			{
				channelType: "telegram",
				chatKind: "dm",
				externalConversationId: "111",
			},
			result,
		);

		expect(transcript.match(/Bot:\n- Text: hello/g)).toHaveLength(1);
	});
});
