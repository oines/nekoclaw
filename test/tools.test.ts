import { describe, expect, it } from "vitest";
import { createToolComposition } from "../src/tools/index.js";
import type {
	ChannelToolAction,
	InboundMessageEvent,
	RuntimeDirectorySnapshot,
	SessionRecord,
} from "../src/types.js";

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

const runtimeDirectory: RuntimeDirectorySnapshot = {
	contacts: [
		{
			account: "telegram:dm:123",
			displayName: "Alice",
			channel: "telegram",
			lastSeenAt: "2026-03-29T00:00:00.000Z",
			pairedSessionKey: session.sessionKey,
			sourceHints: ["seen_in_dm"],
		},
		{
			account: "napcat:dm:456",
			displayName: "Bob",
			channel: "napcat",
			lastSeenAt: "2026-03-29T00:05:00.000Z",
			sourceHints: ["pair_request"],
		},
	],
	groups: [
		{
			groupRef: "telegram:group:-1001",
			title: "Tech Group",
			channel: "telegram",
			lastSeenAt: "2026-03-29T00:10:00.000Z",
		},
	],
	groupMembers: {
		"telegram:group:-1001": [
			{
				account: "telegram:dm:123",
				displayName: "Alice",
				lastSeenAt: "2026-03-29T00:10:00.000Z",
				source: "runtime_seen",
			},
		],
	},
	availableChannels: ["napcat", "telegram"],
};

function createContext(input: {
	actions?: ChannelToolAction[];
	chatKind?: "dm" | "group";
	isExplicitlyAddressed?: boolean;
} = {}) {
	const actions = input.actions ?? [];
	const chatKind = input.chatKind ?? "dm";
	return createToolComposition({
		session: {
			...session,
			chatKind,
			externalConversationId: chatKind === "group" ? "-1001" : session.externalConversationId,
		},
		event: {
			...event,
			chatKind,
			chatId: chatKind === "group" ? "-1001" : event.chatId,
		},
		capabilities: {
			text: true,
			media: true,
			reply: true,
			edit: true,
			delete: true,
			typing: true,
		},
		runtimeDirectory,
		isExplicitlyAddressed: input.isExplicitlyAddressed ?? false,
		recordAction: (action) => {
			actions.push(action);
		},
	});
}

describe("tool composition", () => {
	it("exposes coding tools plus nekoclaw product tools", async () => {
		const actions: ChannelToolAction[] = [];
		const composition = createContext({ actions, chatKind: "group" });

		expect(composition.codingTools.map((tool) => tool.name)).toEqual(["read", "bash", "edit", "write"]);
		expect(composition.nekoclawTools.map((tool) => tool.name)).toEqual([
			"message",
			"list_contacts",
			"list_groups",
			"get_group_members",
			"get_contact_detail",
			"send_message",
			"session_status",
			"no_reply",
		]);
		expect(composition.customTools.map((tool) => tool.name)).toEqual([
			"message",
			"list_contacts",
			"list_groups",
			"get_group_members",
			"get_contact_detail",
			"send_message",
			"session_status",
			"no_reply",
		]);

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

	it("lists runtime-known contacts and groups from the snapshot", async () => {
		const composition = createContext({ chatKind: "group" });
		const listContacts = composition.customTools.find((tool) => tool.name === "list_contacts");
		const listGroups = composition.customTools.find((tool) => tool.name === "list_groups");

		const contactsResult = await listContacts?.execute("tool-contacts", { channel: "telegram" }, undefined, undefined, undefined as never);
		const groupsResult = await listGroups?.execute("tool-groups", {}, undefined, undefined, undefined as never);

		expect(contactsResult?.details).toEqual({
			contacts: [runtimeDirectory.contacts[0]],
		});
		expect(groupsResult?.details).toEqual({
			groups: runtimeDirectory.groups,
		});
	});

	it("returns group members and contact details from the snapshot", async () => {
		const composition = createContext({ chatKind: "group" });
		const membersTool = composition.customTools.find((tool) => tool.name === "get_group_members");
		const contactTool = composition.customTools.find((tool) => tool.name === "get_contact_detail");

		const membersResult = await membersTool?.execute(
			"tool-members",
			{ groupRef: "telegram:group:-1001" },
			undefined,
			undefined,
			undefined as never,
		);
		const contactResult = await contactTool?.execute(
			"tool-contact",
			{ account: "telegram:dm:123" },
			undefined,
			undefined,
			undefined as never,
		);

		expect(membersResult?.details).toEqual({
			group: runtimeDirectory.groups[0],
			members: runtimeDirectory.groupMembers["telegram:group:-1001"],
		});
		expect(contactResult?.details).toEqual(runtimeDirectory.contacts[0]);
	});

	it("records a targeted proactive message separately from current-session message actions", async () => {
		const actions: ChannelToolAction[] = [];
		const composition = createContext({ actions, chatKind: "group" });
		const sendMessageTool = composition.customTools.find((tool) => tool.name === "send_message");

		await sendMessageTool?.execute(
			"tool-send-targeted",
			{
				target: "napcat:dm:456",
				text: "ping from proactive send",
			},
			undefined,
			undefined,
			undefined as never,
		);

		expect(actions).toEqual([
			{
				kind: "send_targeted",
				target: "napcat:dm:456",
				payload: {
					text: "ping from proactive send",
					attachments: undefined,
				},
			},
		]);
	});

	it("rejects unknown proactive targets", async () => {
		const composition = createContext({ chatKind: "group" });
		const sendMessageTool = composition.customTools.find((tool) => tool.name === "send_message");

		await expect(
			sendMessageTool?.execute(
				"tool-send-targeted",
				{
					target: "telegram:dm:999",
					text: "ping from proactive send",
				},
				undefined,
				undefined,
				undefined as never,
			),
		).rejects.toThrow(/Unknown target/);
	});

	it("records an explicit no_reply action", async () => {
		const actions: ChannelToolAction[] = [];
		const composition = createContext({ actions, chatKind: "group" });

		const tool = composition.customTools.find((entry) => entry.name === "no_reply");
		await tool?.execute("tool-2", {}, undefined, undefined, undefined as never);

		expect(actions).toEqual([{ kind: "no_reply" }]);
	});

	it("does not expose no_reply in direct messages", () => {
		const composition = createContext();

		expect(composition.nekoclawTools.map((tool) => tool.name)).toEqual([
			"message",
			"list_contacts",
			"list_groups",
			"get_group_members",
			"get_contact_detail",
			"send_message",
			"session_status",
		]);
		expect(composition.customTools.map((tool) => tool.name)).toEqual([
			"message",
			"list_contacts",
			"list_groups",
			"get_group_members",
			"get_contact_detail",
			"send_message",
			"session_status",
		]);
	});

	it("does not expose no_reply for explicitly mentioned group messages", () => {
		const composition = createContext({ chatKind: "group", isExplicitlyAddressed: true });

		expect(composition.nekoclawTools.map((tool) => tool.name)).toEqual([
			"message",
			"list_contacts",
			"list_groups",
			"get_group_members",
			"get_contact_detail",
			"send_message",
			"session_status",
		]);
		expect(composition.customTools.map((tool) => tool.name)).toEqual([
			"message",
			"list_contacts",
			"list_groups",
			"get_group_members",
			"get_contact_detail",
			"send_message",
			"session_status",
		]);
	});
});
