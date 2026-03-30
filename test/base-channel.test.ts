import { describe, expect, it } from "vitest";
import { createPairingAdapter } from "../src/channels/base-channel.js";
import type { InboundMessageEvent } from "../src/types.js";

describe("base channel pairing adapter", () => {
	it("offers pairing for a group pair command prefixed by a mention", () => {
		const pairing = createPairingAdapter();
		const event: InboundMessageEvent = {
			eventType: "message.created",
			channelType: "telegram",
			chatId: "-1001",
			chatKind: "group",
			messageId: "1",
			sender: { externalId: "42" },
			blocks: [{ kind: "text", text: "@mybot /pair" }],
			mentionedUsernames: ["mybot"],
			occurredAt: "2026-03-29T00:00:00.000Z",
		};

		expect(pairing.shouldOfferPair(event)).toBe(true);
	});

	it("does not treat arbitrary text before /pair as a pair command", () => {
		const pairing = createPairingAdapter();
		const event: InboundMessageEvent = {
			eventType: "message.created",
			channelType: "telegram",
			chatId: "-1002",
			chatKind: "group",
			messageId: "2",
			sender: { externalId: "42" },
			blocks: [{ kind: "text", text: "hello /pair" }],
			occurredAt: "2026-03-29T00:00:00.000Z",
		};

		expect(pairing.shouldOfferPair(event)).toBe(false);
	});
});
