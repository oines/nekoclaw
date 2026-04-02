import { describe, expect, it } from "vitest";
import { parseAddressedSlashCommand } from "../src/command-parsing.js";
import type { InboundMessageEvent } from "../src/types.js";

function createGroupEvent(text: string, overrides: Partial<InboundMessageEvent> = {}): InboundMessageEvent {
	return {
		eventType: "message.created",
		channelType: "telegram",
		chatId: "-1001",
		chatKind: "group",
		messageId: "1",
		sender: { externalId: "42" },
		blocks: [{ kind: "text", text }],
		occurredAt: "2026-03-29T00:00:00.000Z",
		...overrides,
	};
}

describe("command parsing", () => {
	it("parses a direct slash command", () => {
		expect(parseAddressedSlashCommand(createGroupEvent("/help"))).toMatchObject({
			command: "help",
		});
	});

	it("parses a slash command after pure mention prefixes", () => {
		expect(
			parseAddressedSlashCommand(
				createGroupEvent("@mybot /status", {
					mentionedUsernames: ["mybot"],
				}),
			),
		).toMatchObject({
			command: "status",
		});
	});

	it("allows reply-addressed commands when the slash command is the first token", () => {
		expect(
			parseAddressedSlashCommand(
				createGroupEvent("/status", {
					replyToMessageId: "9",
					isReplyToBot: true,
				}),
			),
		).toMatchObject({
			command: "status",
		});
	});

	it("rejects slash commands preceded by arbitrary text even if the event is addressed", () => {
		expect(
			parseAddressedSlashCommand(
				createGroupEvent("@mybot hello /help", {
					mentionedUsernames: ["mybot"],
				}),
			),
		).toBeUndefined();
	});
});
