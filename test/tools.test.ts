import { describe, expect, it } from "vitest";
import { createToolComposition } from "../src/tools/index.js";
import type { ChannelToolAction, InboundMessageEvent, SessionRecord } from "../src/types.js";

const session: SessionRecord = {
	sessionRecordId: "chat-1",
	agentId: "agent-1",
	channelType: "telegram",
	externalConversationId: "123",
	chatKind: "dm",
	sessionKey: "agent:cat-agent:telegram:direct:123",
	status: "active",
	createdAt: "2026-03-29T00:00:00.000Z",
	updatedAt: "2026-03-29T00:00:00.000Z",
};

const event: InboundMessageEvent = {
	eventType: "message.created",
	channelType: "telegram",
	chatId: "123",
	chatKind: "dm",
	messageId: "777",
	sender: {
		externalId: "user-1",
		displayName: "Alice",
	},
	blocks: [{ kind: "text", text: "hello" }],
	occurredAt: "2026-03-29T00:00:00.000Z",
};

describe("tool composition", () => {
	it("exposes coding tools plus nekoclaw product tools", async () => {
		const actions: ChannelToolAction[] = [];
		const composition = createToolComposition({
			session: {
				...session,
				chatKind: "group",
			},
			event: {
				...event,
				chatKind: "group",
				chatId: "-1001",
			},
			capabilities: {
				text: true,
				media: true,
				reply: true,
				edit: true,
				delete: true,
				typing: true,
			},
			isExplicitlyAddressed: false,
			recordAction: (action) => {
				actions.push(action);
			},
		});

		expect(composition.codingTools.map((tool) => tool.name)).toEqual(["read", "bash", "edit", "write"]);
		expect(composition.nekoclawTools.map((tool) => tool.name)).toEqual(["message", "session_status", "no_reply"]);
		expect(composition.customTools.map((tool) => tool.name)).toEqual(["message", "session_status", "no_reply"]);

		const messageTool = composition.customTools.find((tool) => tool.name === "message");
		expect(messageTool).toBeDefined();

		await messageTool?.execute(
			"tool-1",
			{
				action: "send",
				text: "hello from tool",
			},
			undefined,
			undefined,
			undefined as never,
		);

		expect(actions).toEqual([
			{
				kind: "send",
				payload: {
					text: "hello from tool",
					attachments: undefined,
					replyToId: undefined,
				},
			},
		]);
	});

	it("records an explicit no_reply action", async () => {
		const actions: ChannelToolAction[] = [];
		const composition = createToolComposition({
			session: {
				...session,
				chatKind: "group",
			},
			event: {
				...event,
				chatKind: "group",
				chatId: "-1001",
			},
			capabilities: {
				text: true,
				media: true,
				reply: true,
				edit: true,
				delete: true,
				typing: true,
			},
			isExplicitlyAddressed: false,
			recordAction: (action) => {
				actions.push(action);
			},
		});

		const tool = composition.customTools.find((entry) => entry.name === "no_reply");
		await tool?.execute("tool-2", {}, undefined, undefined, undefined as never);

		expect(actions).toEqual([{ kind: "no_reply" }]);
	});

	it("does not expose no_reply in direct messages", () => {
		const composition = createToolComposition({
			session,
			event,
			capabilities: {
				text: true,
				media: true,
				reply: true,
				edit: true,
				delete: true,
				typing: true,
			},
			isExplicitlyAddressed: false,
			recordAction: () => undefined,
		});

		expect(composition.nekoclawTools.map((tool) => tool.name)).toEqual(["message", "session_status"]);
		expect(composition.customTools.map((tool) => tool.name)).toEqual(["message", "session_status"]);
	});

	it("does not expose no_reply for explicitly mentioned group messages", () => {
		const composition = createToolComposition({
			session: {
				...session,
				chatKind: "group",
			},
			event: {
				...event,
				chatKind: "group",
				chatId: "-1001",
				mentionedUsernames: ["mybot"],
			},
			capabilities: {
				text: true,
				media: true,
				reply: true,
				edit: true,
				delete: true,
				typing: true,
			},
			isExplicitlyAddressed: true,
			recordAction: () => undefined,
		});

		expect(composition.nekoclawTools.map((tool) => tool.name)).toEqual(["message", "session_status"]);
		expect(composition.customTools.map((tool) => tool.name)).toEqual(["message", "session_status"]);
	});

	it("does not expose no_reply for quoted group replies", () => {
		const composition = createToolComposition({
			session: {
				...session,
				chatKind: "group",
			},
			event: {
				...event,
				chatKind: "group",
				chatId: "-1001",
				replyToMessageId: "888",
			},
			capabilities: {
				text: true,
				media: true,
				reply: true,
				edit: true,
				delete: true,
				typing: true,
			},
			isExplicitlyAddressed: true,
			recordAction: () => undefined,
		});

		expect(composition.nekoclawTools.map((tool) => tool.name)).toEqual(["message", "session_status"]);
		expect(composition.customTools.map((tool) => tool.name)).toEqual(["message", "session_status"]);
	});

	it("still exposes no_reply when the message only mentions someone else", () => {
		const composition = createToolComposition({
			session: {
				...session,
				chatKind: "group",
			},
			event: {
				...event,
				chatKind: "group",
				chatId: "-1001",
				mentionedUsernames: ["alice"],
			},
			capabilities: {
				text: true,
				media: true,
				reply: true,
				edit: true,
				delete: true,
				typing: true,
			},
			isExplicitlyAddressed: false,
			recordAction: () => undefined,
		});

		expect(composition.nekoclawTools.map((tool) => tool.name)).toEqual(["message", "session_status", "no_reply"]);
		expect(composition.customTools.map((tool) => tool.name)).toEqual(["message", "session_status", "no_reply"]);
	});
});
