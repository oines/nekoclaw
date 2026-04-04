import { describe, expect, it } from "vitest";
import { trimToTokenBudget, takeTailLinesWithinBudget } from "../src/runtime/persona-memory/observations.js";
import { buildBotOutboundSessionLogEntry, buildFormationTimeline, buildInboundSessionLogEntry } from "../src/runtime/session-log.js";
import type { InboundMessageEvent } from "../src/types.js";

const countByChars = async (value: string) => ({ available: true as const, tokens: value.length });

function createEvent(input: {
	messageId: string;
	senderId: string;
	text: string;
	occurredAt: string;
}): InboundMessageEvent {
	return {
		eventType: "message.created",
		channelType: "telegram",
		chatId: "chat-1",
		chatKind: "dm",
		messageId: input.messageId,
		sender: { externalId: input.senderId, displayName: input.senderId },
		blocks: [{ kind: "text", text: input.text }],
		occurredAt: input.occurredAt,
	};
}

describe("exact token budget helpers", () => {
	it("keeps the largest exact prefix that fits the token budget", async () => {
		const trimmed = await trimToTokenBudget(["aa", "bbbb", "cc"].join("\n"), 7, countByChars);
		expect(trimmed).toBe(["aa", "bbbb"].join("\n"));
	});

	it("keeps the largest exact tail within the token budget after applying the line cap", async () => {
		const trimmed = await takeTailLinesWithinBudget(["1111", "22", "333", "4"].join("\n"), 3, 6, countByChars);
		expect(trimmed).toBe(["333", "4"].join("\n"));
	});

	it("keeps the newest exact formation turns within budget", async () => {
		const first = createEvent({
			messageId: "m1",
			senderId: "alice",
			text: "first turn that is intentionally much longer than the later turns for budget trimming",
			occurredAt: "2026-04-04T00:00:00.000Z",
		});
		const second = createEvent({
			messageId: "m2",
			senderId: "alice",
			text: "second turn",
			occurredAt: "2026-04-04T00:00:01.000Z",
		});
		const timeline = await buildFormationTimeline({
			logEntries: [
				buildInboundSessionLogEntry(first),
				buildBotOutboundSessionLogEntry({
					timestamp: "2026-04-04T00:00:00.500Z",
					session: {
						sessionRecordId: "session-1",
						channelType: "telegram",
						externalConversationId: "chat-1",
						chatKind: "dm",
					},
					payload: { text: "bot reply" },
					source: "outbound",
				}),
				buildInboundSessionLogEntry(second),
			],
			currentEvent: second,
			tokenBudget: 180,
			countTextTokens: countByChars,
		});

		expect(timeline).toContain("second turn");
		expect(timeline).toContain("bot reply");
		expect(timeline).not.toContain("first turn");
	});
});
