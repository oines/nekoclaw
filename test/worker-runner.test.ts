import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendJsonLine } from "../src/store/fs.js";
import { buildBotOutboundSessionLogEntry, buildInboundSessionLogEntry } from "../src/runtime/session-log.js";
import type { InboundMessageEvent, WorkerResult } from "../src/types.js";

function createEvent(input: {
	channelType: "telegram" | "napcat";
	chatId: string;
	chatKind: "dm" | "group";
	messageId: string;
	replyToMessageId?: string;
	mentionedUserIds?: string[];
	mentionedUsernames?: string[];
	senderId: string;
	senderName?: string;
	text: string;
	occurredAt: string;
	chatTitle?: string;
}): InboundMessageEvent {
	return {
		eventType: "message.created",
		channelType: input.channelType,
		chatId: input.chatId,
		chatKind: input.chatKind,
		chatTitle: input.chatTitle,
		messageId: input.messageId,
		replyToMessageId: input.replyToMessageId,
		mentionedUserIds: input.mentionedUserIds,
		mentionedUsernames: input.mentionedUsernames,
		sender: { externalId: input.senderId, displayName: input.senderName },
		blocks: [{ kind: "text", text: input.text }],
		occurredAt: input.occurredAt,
	};
}

describe("buildFormationTurnTranscript", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "nekoclaw-worker-runner-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("builds a recent chronological timeline from session log entries without duplicating current bot outputs", async () => {
		const { buildFormationTurnTranscript } = await import("../src/runtime/worker-runner.js");

		const logPath = join(tempDir, "log.jsonl");
		appendJsonLine(
			logPath,
			buildInboundSessionLogEntry(
				createEvent({
					channelType: "telegram",
					chatId: "111",
					chatKind: "dm",
					messageId: "m0",
					senderId: "u2",
					senderName: "Bob",
					text: "昨天那个数据库别动",
					occurredAt: "2026-04-04T00:00:00.000Z",
				}),
			),
		);
		appendJsonLine(
			logPath,
			buildBotOutboundSessionLogEntry({
				timestamp: "2026-04-04T00:00:01.000Z",
				session: {
					sessionRecordId: "session-1",
					channelType: "telegram",
					externalConversationId: "111",
					chatKind: "dm",
				},
				payload: { text: "我先不重启，等你确认" },
				source: "tool.reply",
			}),
		);
		const currentEvent = createEvent({
			channelType: "telegram",
			chatId: "111",
			chatKind: "dm",
			messageId: "m1",
			senderId: "u1",
			senderName: "Alice",
			text: "现在可以把结果总结一下吗",
			occurredAt: "2026-04-04T00:00:02.000Z",
		});
		appendJsonLine(logPath, buildInboundSessionLogEntry(currentEvent));
		appendJsonLine(
			logPath,
			buildBotOutboundSessionLogEntry({
				timestamp: "2026-04-04T00:00:03.000Z",
				session: {
					sessionRecordId: "session-1",
					channelType: "telegram",
					externalConversationId: "111",
					chatKind: "dm",
				},
				payload: { text: "final visible reply", attachments: [{ kind: "file", name: "summary.txt" }] },
				source: "outbound",
			}),
		);

		const result: WorkerResult = {
			outbound: {
				text: "final visible reply",
				attachments: [{ kind: "file", name: "summary.txt" }],
			},
			toolActions: [
				{
					kind: "reply",
					payload: {
						text: "我先不重启，等你确认",
					},
				},
			],
		};

		const transcript = await buildFormationTurnTranscript(
			{
				getSessionLogPath: () => logPath,
			} as any,
			{ slug: "timeline-cat" } as any,
			{ event: currentEvent },
			{
				sessionRecordId: "session-1",
				channelType: "telegram",
				chatKind: "dm",
				externalConversationId: "111",
			},
			result,
		);

		expect(transcript).toContain("[2026-04-04T00:00:00.000Z] Observed (telegram:u2 | Bob):");
		expect(transcript).toContain("昨天那个数据库别动");
		expect(transcript).toContain("[2026-04-04T00:00:01.000Z] Bot (source=tool.reply):");
		expect(transcript).toContain("[2026-04-04T00:00:02.000Z] User (telegram:u1 | Alice):");
		expect(transcript).toContain("[2026-04-04T00:00:03.000Z] Bot (source=outbound):");
		expect(transcript).toContain("- File: summary.txt");
		expect(transcript.match(/final visible reply/g)).toHaveLength(1);
		expect(transcript.match(/我先不重启，等你确认/g)).toHaveLength(1);
	});

	it("ignores slash commands and non-current-session visible actions, and falls back to current run bot outputs when the log has not recorded them yet", async () => {
		const { buildFormationTurnTranscript } = await import("../src/runtime/worker-runner.js");

		const logPath = join(tempDir, "log.jsonl");
		appendJsonLine(
			logPath,
			buildInboundSessionLogEntry(
				createEvent({
					channelType: "telegram",
					chatId: "111",
					chatKind: "dm",
					messageId: "cmd-1",
					senderId: "u1",
					senderName: "Alice",
					text: "/help",
					occurredAt: "2026-04-04T00:00:00.000Z",
				}),
			),
		);
		const currentEvent = createEvent({
			channelType: "telegram",
			chatId: "111",
			chatKind: "dm",
			messageId: "m1",
			senderId: "u1",
			senderName: "Alice",
			text: "hello",
			occurredAt: "2026-04-04T00:00:01.000Z",
		});
		appendJsonLine(logPath, buildInboundSessionLogEntry(currentEvent));

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

		const transcript = await buildFormationTurnTranscript(
			{
				getSessionLogPath: () => logPath,
			} as any,
			{ slug: "timeline-cat" } as any,
			{ event: currentEvent },
			{
				sessionRecordId: "session-1",
				channelType: "telegram",
				chatKind: "dm",
				externalConversationId: "111",
			},
			result,
		);

		expect(transcript).toContain("[2026-04-04T00:00:01.000Z] User (telegram:u1 | Alice):");
		expect(transcript).toContain("- File: application/zip");
		expect(transcript).toContain("source=current_run_fallback");
		expect(transcript).not.toContain("/help");
		expect(transcript).not.toContain("other room");
	});

	it("includes reply context in the formation timeline for both human and bot targets", async () => {
		const { buildFormationTurnTranscript } = await import("../src/runtime/worker-runner.js");

		const logPath = join(tempDir, "reply-log.jsonl");
		appendJsonLine(
			logPath,
			buildInboundSessionLogEntry(
				createEvent({
					channelType: "telegram",
					chatId: "111",
					chatKind: "dm",
					messageId: "m0",
					senderId: "u2",
					senderName: "Bob",
					text: "数据库先别动",
					occurredAt: "2026-04-04T00:00:00.000Z",
				}),
			),
		);
		appendJsonLine(
			logPath,
			buildBotOutboundSessionLogEntry({
				timestamp: "2026-04-04T00:00:01.000Z",
				session: {
					sessionRecordId: "session-1",
					channelType: "telegram",
					externalConversationId: "111",
					chatKind: "dm",
				},
				payload: { text: "我先不重启，等你确认" },
				source: "outbound",
				messageIds: ["bot-1"],
			}),
		);
		appendJsonLine(
			logPath,
			buildInboundSessionLogEntry(
				createEvent({
					channelType: "telegram",
					chatId: "111",
					chatKind: "dm",
					messageId: "m1",
					replyToMessageId: "m0",
					senderId: "u1",
					senderName: "Alice",
					text: "不行，支付已经炸了",
					occurredAt: "2026-04-04T00:00:02.000Z",
				}),
			),
		);
		const currentEvent = createEvent({
			channelType: "telegram",
			chatId: "111",
			chatKind: "dm",
			messageId: "m2",
			replyToMessageId: "bot-1",
			senderId: "u1",
			senderName: "Alice",
			text: "那你现在总结一下",
			occurredAt: "2026-04-04T00:00:03.000Z",
		});
		appendJsonLine(logPath, buildInboundSessionLogEntry(currentEvent));

		const transcript = await buildFormationTurnTranscript(
			{
				getSessionLogPath: () => logPath,
			} as any,
			{ slug: "timeline-cat" } as any,
			{ event: currentEvent },
			{
				sessionRecordId: "session-1",
				channelType: "telegram",
				chatKind: "dm",
				externalConversationId: "111",
			},
			{ outbound: {} },
		);

		expect(transcript).toContain("Alice reply_to Bob: Text: 数据库先别动");
		expect(transcript).toContain("Alice: Text: 不行，支付已经炸了");
		expect(transcript).toContain("Alice reply_to Bot: Text: 我先不重启，等你确认");
		expect(transcript).toContain("Alice: Text: 那你现在总结一下");
	});

	it("includes explicit mention metadata in the formation timeline", async () => {
		const { buildFormationTurnTranscript } = await import("../src/runtime/worker-runner.js");

		const logPath = join(tempDir, "mention-log.jsonl");
		const currentEvent = createEvent({
			channelType: "telegram",
			chatId: "-1001",
			chatKind: "group",
			chatTitle: "Ops",
			messageId: "m-mention-1",
			mentionedUsernames: ["mock_bot", "db_admin"],
			senderId: "u1",
			senderName: "Alice",
			text: "@mock_bot 让 @db_admin 看看数据库",
			occurredAt: "2026-04-04T00:00:00.000Z",
		});
		appendJsonLine(logPath, buildInboundSessionLogEntry(currentEvent));

		const transcript = await buildFormationTurnTranscript(
			{
				getSessionLogPath: () => logPath,
			} as any,
			{ slug: "timeline-cat" } as any,
			{ event: currentEvent },
			{
				sessionRecordId: "session-1",
				channelType: "telegram",
				chatKind: "group",
				externalConversationId: "-1001",
				chatTitle: "Ops",
			},
			{ outbound: {} },
		);

		expect(transcript).toContain("[2026-04-04T00:00:00.000Z] User (telegram:u1 | Alice | scene=Ops):");
		expect(transcript).toContain("Mentions: @mock_bot, @db_admin");
		expect(transcript).toContain("Text: @mock_bot 让 @db_admin 看看数据库");
	});
});
