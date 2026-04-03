import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAppendPrompt, collectPromptImages } from "../src/runtime/worker.js";
import type { SessionCronRecord, WorkerPayload } from "../src/types.js";

const sessionCrons: SessionCronRecord[] = [
	{
		cronId: "cron-1",
		agentId: "agent-1",
		sessionRecordId: "session-1",
		sessionKey: "agent:test-agent:telegram:group:1",
		channelType: "telegram",
		chatKind: "group",
		externalConversationId: "1",
		status: "active",
		scheduleKind: "daily",
		message: "daily reminder",
		timezone: "Asia/Shanghai",
		hour: 7,
		minute: 0,
		nextRunAt: "2026-03-29T23:00:00.000Z",
		createdAt: "2026-03-29T00:00:00.000Z",
		updatedAt: "2026-03-29T00:00:00.000Z",
		createdFromResetGeneration: 0,
	},
];

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
			resetGeneration: 0,
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
		runtimeDirectory: {
			contacts: [],
			groups: [],
			groupMembers: {},
			availableChannels: [channelType === "napcat" ? "qq" : "telegram"],
		},
		serverTimezone: "Asia/Shanghai",
		sessionCrons,
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
		expect(prompt).toContain("Use the `send_message` tool");
		expect(prompt).toContain("Use the `cron` tool");
		expect(prompt).toContain("Asia/Shanghai");
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

	it("includes prepared persona context when available", () => {
		const payload: WorkerPayload = {
			...createPayload("telegram"),
			personaContext: {
				indexMarkdown: "## 我认识的人\n- 小王：毕业论文相关 → memory/people/telegram-111.md",
				sceneObservations: "[2026-04-01T00:00:00.000Z] telegram:111 小王: 支付接口又挂了",
			},
		};

		const prompt = buildAppendPrompt(payload, "", "");
		expect(prompt).toContain("## Persona Index");
		expect(prompt).toContain("## Current Scene Observations");
		expect(prompt).toContain("use the built-in `read` tool");
		expect(prompt).toContain("file path referenced in index.md");
		expect(prompt).not.toContain("## Persona Selection Notes");
		expect(prompt).not.toContain("## Selected Persona Memories");
	});

	it("mentions scheduled reminder context when present", () => {
		const payload: WorkerPayload = {
			...createPayload("telegram"),
			scheduledReminder: {
				cronId: "cron-1",
				message: "wake me up",
				timezone: "Asia/Shanghai",
				scheduledFor: "2026-03-29T23:00:00.000Z",
			},
		};

		const prompt = buildAppendPrompt(payload, "", "");
		expect(prompt).toContain("Server local timezone");
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

	it("reuses recent image history when the current turn has no image block", () => {
		const workspaceDir = mkdtempSync(join(tmpdir(), "nekoclaw-worker-history-"));
		const relativePath = "chats/session-1/attachments/history-image.png";
		const absolutePath = join(workspaceDir, relativePath);
		mkdirSync(join(workspaceDir, "chats/session-1/attachments"), { recursive: true });
		writeFileSync(absolutePath, Buffer.from([4, 5, 6]));
		const payload: WorkerPayload = {
			...createPayload("telegram"),
			job: {
				...createPayload("telegram").job,
				event: {
					...createPayload("telegram").job.event,
					blocks: [{ kind: "text", text: "what was in that picture?" }],
				},
			},
		};

		const images = collectPromptImages(payload, workspaceDir, [
			{
				role: "user",
				content: `Event: message.created\nContent:\n- Image: ${relativePath}`,
			} as never,
		]);

		expect(images).toEqual([
			{
				type: "image",
				data: Buffer.from([4, 5, 6]).toString("base64"),
				mimeType: "image/jpeg",
			},
		]);
		rmSync(workspaceDir, { recursive: true, force: true });
	});
});
