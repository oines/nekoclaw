import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAppendPrompt, collectPromptImages } from "../src/runtime/worker.js";
import type { WorkerPayload } from "../src/types.js";

function createPayload(channelType: "telegram" | "napcat"): WorkerPayload {
	return {
		agent: {
			agentId: "agent-1",
			slug: "test-agent",
			image: "node:22-bookworm-slim",
			containerName: "nekoclaw-test-agent",
			enabled: true,
			createdAt: "2026-03-29T00:00:00.000Z",
			updatedAt: "2026-03-29T00:00:00.000Z",
		},
		job: {
			jobId: "job-1",
			agentId: "agent-1",
			kind: "inbound",
			sessionRecordId: "session-1",
			sessionKey: `agent:test-agent:${channelType}:group:1`,
			createdAt: "2026-03-29T00:00:00.000Z",
			event: {
				eventType: "message.created",
				channelType,
				chatId: "1",
				chatKind: "group",
				messageId: "2",
				replyToMessageId: "1",
				sender: { externalId: "user-1", displayName: "Alice" },
				blocks: [{ kind: "text", text: "hello" }],
				occurredAt: "2026-03-29T00:00:00.000Z",
			},
		},
		currentSession: {
			sessionRecordId: "session-1",
			agentId: "agent-1",
			sessionKey: `agent:test-agent:${channelType}:group:1`,
			channelType,
			externalConversationId: "1",
			chatKind: "group",
			status: "active",
			createdAt: "2026-03-29T00:00:00.000Z",
			updatedAt: "2026-03-29T00:00:00.000Z",
		},
		capabilities: {
			text: true,
			media: true,
			reply: true,
			edit: channelType === "telegram",
			delete: true,
			typing: channelType === "telegram",
		},
	};
}

describe("worker append prompt", () => {
	it("includes matched telegram handles when present", () => {
		const payload: WorkerPayload = {
			...createPayload("telegram"),
			selfIdentity: {
				telegramHandles: ["@mock_bot"],
				isExplicitlyAddressed: true,
			},
		};

		const prompt = buildAppendPrompt(payload, "", "");
		expect(prompt).toContain("You may be addressed in this session as: @mock_bot");
		expect(prompt).toContain("already matched as being addressed to you");
	});

	it("includes the configured platform user id for napcat", () => {
		const payload: WorkerPayload = {
			...createPayload("napcat"),
			selfIdentity: {
				platformUserId: "1234567890",
				isExplicitlyAddressed: true,
			},
		};

		const prompt = buildAppendPrompt(payload, "", "");
		expect(prompt).toContain("Your platform user id in this session: 1234567890");
		expect(prompt).toContain("already matched as being addressed to you");
	});

	it("collects hydrated image attachments as multimodal input", () => {
		const workspaceDir = mkdtempSync(join(tmpdir(), "nekoclaw-worker-"));
		const relativePath = "chats/session-1/attachments/image.png";
		const absolutePath = join(workspaceDir, relativePath);
		mkdirSync(join(workspaceDir, "chats/session-1/attachments"), { recursive: true });
		writeFileSync(absolutePath, Buffer.from([1, 2, 3]));
		const payload: WorkerPayload = {
			...createPayload("telegram"),
			job: {
				...createPayload("telegram").job,
				event: {
					...createPayload("telegram").job.event,
					blocks: [
						{
							kind: "image",
							name: "image.png",
							mimeType: "image/png",
							attachment: {
								kind: "image",
								name: "image.png",
								relativePath,
								mimeType: "image/png",
							},
						},
						{
							kind: "file",
							name: "spec.pdf",
							mimeType: "application/pdf",
							attachment: {
								kind: "file",
								name: "spec.pdf",
								relativePath: "chats/session-1/attachments/spec.pdf",
								mimeType: "application/pdf",
							},
						},
					],
				},
			},
		};

		const images = collectPromptImages(payload, workspaceDir);

		expect(images).toEqual([
			{
				type: "image",
				data: Buffer.from([1, 2, 3]).toString("base64"),
				mimeType: "image/png",
			},
		]);
		rmSync(workspaceDir, { recursive: true, force: true });
	});
});
