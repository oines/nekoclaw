import { Type, type Static } from "@sinclair/typebox";
import { codingTools, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import { parseTargetRef } from "../runtime/runtime-directory.js";
import {
	SESSION_COMPACTION_SETTINGS,
	SESSION_PRUNING_ENABLED,
	SESSION_PRUNING_OVERSIZED_RESULT_CHARS,
	SESSION_PRUNING_PROTECTED_ASSISTANT_MESSAGES,
	SESSION_PRUNING_TOOL_RESULT_BUDGET_CHARS,
} from "../runtime/session-hygiene.js";
import type { ChannelToolContext, OutboundAttachment } from "../types.js";

const AttachmentSchema = Type.Object({
	kind: Type.Union([Type.Literal("image"), Type.Literal("file")]),
	filePath: Type.Optional(Type.String({ description: "Absolute path to a local file to upload." })),
	url: Type.Optional(Type.String({ description: "Remote URL to send without downloading locally first." })),
	name: Type.Optional(Type.String()),
	mimeType: Type.Optional(Type.String()),
});

const MessageToolParameters = Type.Object({
	action: Type.Union([
		Type.Literal("send"),
		Type.Literal("reply"),
		Type.Literal("edit"),
		Type.Literal("delete"),
		Type.Literal("typing"),
	]),
	text: Type.Optional(Type.String()),
	replyToId: Type.Optional(Type.String({ description: "Explicit message id to reply to." })),
	messageId: Type.Optional(Type.String({ description: "Existing message id for edit/delete actions." })),
	attachments: Type.Optional(Type.Array(AttachmentSchema)),
});
const ListContactsParameters = Type.Object({
	channel: Type.Optional(Type.Union([Type.Literal("telegram"), Type.Literal("qq")])),
});
const ListGroupsParameters = Type.Object({
	channel: Type.Optional(Type.Union([Type.Literal("telegram"), Type.Literal("qq")])),
});
const GetGroupMembersParameters = Type.Object({
	groupRef: Type.String({ description: "Explicit group ref like telegram:group:-1001 or qq:group:123456." }),
});
const GetContactDetailParameters = Type.Object({
	account: Type.String({ description: "Explicit contact ref like telegram:dm:12345 or qq:dm:67890." }),
});
const SendMessageParameters = Type.Object({
	target: Type.String({ description: "Explicit target ref like telegram:dm:12345 or qq:group:67890." }),
	text: Type.Optional(Type.String()),
	attachments: Type.Optional(Type.Array(AttachmentSchema)),
});

const SessionStatusParameters = Type.Object({});
const NoReplyParameters = Type.Object({});

type MessageToolInput = Static<typeof MessageToolParameters>;
type ListContactsInput = Static<typeof ListContactsParameters>;
type ListGroupsInput = Static<typeof ListGroupsParameters>;
type GetGroupMembersInput = Static<typeof GetGroupMembersParameters>;
type GetContactDetailInput = Static<typeof GetContactDetailParameters>;
type SendMessageInput = Static<typeof SendMessageParameters>;

function hasRenderableContent(text: string | undefined, attachments: OutboundAttachment[] | undefined): boolean {
	return Boolean(text?.trim()) || Boolean(attachments?.length);
}

function normalizeAttachments(attachments: MessageToolInput["attachments"]): OutboundAttachment[] | undefined {
	if (!attachments?.length) {
		return undefined;
	}
	return attachments.map((attachment) => ({
		kind: attachment.kind,
		filePath: attachment.filePath,
		url: attachment.url,
		name: attachment.name,
		mimeType: attachment.mimeType,
	}));
}

function failUnknownTarget(target: string): never {
	throw new Error(
		`Unknown target "${target}". Use list_contacts or list_groups first and pass an explicit ref like telegram:dm:123 or qq:group:456.`,
	);
}

function serializeGroupForModel<T extends { title?: string }>(group: T): Omit<T, "title"> & { title: string | null } {
	return {
		...group,
		title: group.title ?? null,
	};
}

function createMessageTool(context: ChannelToolContext): ToolDefinition {
	return {
		name: "message",
		label: "Message",
		description: "Advanced current-session channel actions ONLY: current-session send/reply/edit/delete/typing.",
		promptSnippet:
			"message(action, text?, attachments?, replyToId?, messageId?): Use ONLY for current-session reply/edit/delete/typing or an explicit current-session send. Use send_message(target, ...) for cross-target outreach.",
		promptGuidelines: [
			"For normal conversational replies, JUST OUTPUT PLAIN TEXT directly. DO NOT invoke this tool.",
			"Use message(action='send'|'reply') ONLY for the current session. Never use it to message some other contact or group.",
			"Use message(action='reply') ONLY when you must explicitly reply to a specific previous message ID.",
			"Use message(action='typing') to show typing while you prepare a longer answer.",
			"Use message(action='edit'|'delete') with a concrete message id.",
			"Use send_message(target, ...) when you need to proactively message another known contact or group.",
		],
		parameters: MessageToolParameters,
		execute: async (_toolCallId, params) => {
			const input = params as MessageToolInput;
			const attachments = normalizeAttachments(input.attachments);
			if (input.action === "typing") {
				context.recordAction({ kind: "typing" });
				return {
					content: [{ type: "text", text: "Typing indicator queued for the current session." }],
					details: { kind: "typing" },
				};
			}

			if (input.action === "edit") {
				if (!input.messageId || !input.text?.trim()) {
					throw new Error("edit requires both messageId and text");
				}
				context.recordAction({
					kind: "edit",
					messageId: input.messageId,
					text: input.text,
				});
				return {
					content: [{ type: "text", text: `Queued edit for message ${input.messageId}.` }],
					details: { kind: "edit", messageId: input.messageId },
				};
			}

			if (input.action === "delete") {
				if (!input.messageId) {
					throw new Error("delete requires messageId");
				}
				context.recordAction({
					kind: "delete",
					messageId: input.messageId,
				});
				return {
					content: [{ type: "text", text: `Queued deletion for message ${input.messageId}.` }],
					details: { kind: "delete", messageId: input.messageId },
				};
			}

			if (!hasRenderableContent(input.text, attachments)) {
				throw new Error(`${input.action} requires text or attachments`);
			}

			const payload = {
				text: input.text,
				attachments,
				replyToId: input.replyToId,
			};

			if (input.action === "reply") {
				context.recordAction({
					kind: "reply",
					payload,
					replyToId: input.replyToId,
				});
				return {
					content: [
						{
							type: "text",
							text: `Queued a reply in the current session${input.replyToId ? ` to ${input.replyToId}` : ""}.`,
						},
					],
					details: { kind: "reply", replyToId: input.replyToId },
				};
			}

			context.recordAction({
				kind: "send",
				payload,
			});
			return {
				content: [{ type: "text", text: "Queued a message in the current session." }],
				details: { kind: "send" },
			};
		},
	};
}

function createListContactsTool(context: ChannelToolContext): ToolDefinition {
	return {
		name: "list_contacts",
		label: "List Contacts",
		description: "Look through the contacts you already know, like checking your own address book before reaching out to someone.",
		promptSnippet:
			"list_contacts(channel?): check who you already know on telegram or qq before choosing someone to contact.",
		promptGuidelines: [
			"Use this when you want to proactively contact someone but need to see which known contacts are currently available to you.",
			"Treat the result like your own address book: it shows people the runtime already knows about, not the platform's full friend list.",
			"Use get_contact_detail(account) after this if you want a closer look at one person before messaging them.",
		],
		parameters: ListContactsParameters,
		execute: async (_toolCallId, params) => {
			const input = params as ListContactsInput;
			const contacts = context.runtimeDirectory.contacts.filter((contact) => !input.channel || contact.channel === input.channel);
			return {
				content: [{ type: "text", text: JSON.stringify(contacts, null, 2) }],
				details: { contacts },
			};
		},
	};
}

function createListGroupsTool(context: ChannelToolContext): ToolDefinition {
	return {
		name: "list_groups",
		label: "List Groups",
		description: "Look through the groups you already know about, like checking which rooms or group chats you have been in.",
		promptSnippet:
			"list_groups(channel?): check which known telegram or qq groups are currently available to you before messaging a group or inspecting its members.",
		promptGuidelines: [
			"Use this when you want to proactively talk in another group and need its explicit group ref first.",
			"Treat the result like a list of group chats the runtime already knows, not a platform-wide directory of every group.",
			"If a group's title is null, treat the group name as unknown. Do not guess or rename it.",
			"Use get_group_members(groupRef) after this if you need to see which known people are associated with one specific group.",
		],
		parameters: ListGroupsParameters,
		execute: async (_toolCallId, params) => {
			const input = params as ListGroupsInput;
			const groups = context.runtimeDirectory.groups.filter((group) => !input.channel || group.channel === input.channel);
			return {
				content: [{ type: "text", text: JSON.stringify(groups.map(serializeGroupForModel), null, 2) }],
				details: { groups },
			};
		},
	};
}

function createGetGroupMembersTool(context: ChannelToolContext): ToolDefinition {
	return {
		name: "get_group_members",
		label: "Group Members",
		description: "Inspect which people you currently know in one specific group, like checking who is in the room before speaking there.",
		promptSnippet:
			"get_group_members(groupRef): inspect the known members of one explicit group ref.",
		promptGuidelines: [
			"Use this after list_groups when you want to understand who you know in a particular group.",
			"Treat the result as your runtime-known view of that group, not a guaranteed full member roster from the platform.",
			"If the group's title is null, treat its name as unknown instead of inventing one.",
			"Use the returned member refs if you later want to inspect someone with get_contact_detail(account).",
		],
		parameters: GetGroupMembersParameters,
		execute: async (_toolCallId, params) => {
			const input = params as GetGroupMembersInput;
			const parsed = parseTargetRef(input.groupRef);
			if (!parsed || parsed.chatKind !== "group") {
				throw new Error("groupRef must look like telegram:group:<id> or qq:group:<id>");
			}
			const group = context.runtimeDirectory.groups.find((entry) => entry.groupRef === input.groupRef);
			if (!group) {
				failUnknownTarget(input.groupRef);
			}
			const members = context.runtimeDirectory.groupMembers[input.groupRef] ?? [];
			return {
				content: [{ type: "text", text: JSON.stringify({ group: serializeGroupForModel(group), members }, null, 2) }],
				details: { group, members },
			};
		},
	};
}

function createGetContactDetailTool(context: ChannelToolContext): ToolDefinition {
	return {
		name: "get_contact_detail",
		label: "Contact Detail",
		description: "Inspect one known person's contact card and recent runtime metadata before you decide how to address them.",
		promptSnippet:
			"get_contact_detail(account): inspect one explicit contact ref to understand who that person is in your current runtime-known world.",
		promptGuidelines: [
			"Use this when you already have a contact ref and want a closer look before messaging or referring to that person.",
			"Treat the result like a contact card built from runtime knowledge, not a guaranteed complete identity record.",
			"Use list_contacts first if you do not yet know which contact ref to inspect.",
		],
		parameters: GetContactDetailParameters,
		execute: async (_toolCallId, params) => {
			const input = params as GetContactDetailInput;
			const parsed = parseTargetRef(input.account);
			if (!parsed || parsed.chatKind !== "dm") {
				throw new Error("account must look like telegram:dm:<id> or qq:dm:<id>");
			}
			const contact = context.runtimeDirectory.contacts.find((entry) => entry.account === input.account);
			if (!contact) {
				failUnknownTarget(input.account);
			}
			return {
				content: [{ type: "text", text: JSON.stringify(contact, null, 2) }],
				details: contact,
			};
		},
	};
}

function createSendMessageTool(context: ChannelToolContext): ToolDefinition {
	return {
		name: "send_message",
		label: "Send Message",
		description: "Proactively start speaking in another known chat, like opening a different conversation window and sending a message there.",
		promptSnippet:
			"send_message(target, text?, attachments?): proactively message another known contact or group outside the current session.",
		promptGuidelines: [
			"Use this only when you want to contact a different person or group than the one you are currently talking to.",
			"Use explicit target refs like telegram:dm:123 or qq:group:456.",
			"Use list_contacts or list_groups first if you are not sure which target ref to use.",
			"For the current session, either respond in plain text or use message(...) for advanced current-session actions instead.",
		],
		parameters: SendMessageParameters,
		execute: async (_toolCallId, params) => {
			const input = params as SendMessageInput;
			const attachments = normalizeAttachments(input.attachments);
			if (!hasRenderableContent(input.text, attachments)) {
				throw new Error("send_message requires text or attachments");
			}
			const parsed = parseTargetRef(input.target);
			if (!parsed) {
					throw new Error("target must look like telegram:dm:<id>, telegram:group:<id>, qq:dm:<id>, or qq:group:<id>");
			}
			const isKnownTarget =
				parsed.chatKind === "dm"
					? context.runtimeDirectory.contacts.some((entry) => entry.account === input.target)
					: context.runtimeDirectory.groups.some((entry) => entry.groupRef === input.target);
			if (!isKnownTarget) {
				failUnknownTarget(input.target);
			}
			context.recordAction({
				kind: "send_targeted",
				target: input.target,
				payload: {
					text: input.text,
					attachments,
				},
			});
			return {
				content: [{ type: "text", text: `Queued a proactive message to ${input.target}.` }],
				details: { kind: "send_targeted", target: input.target },
			};
		},
	};
}

function createSessionStatusTool(context: ChannelToolContext): ToolDefinition {
	return {
		name: "session_status",
		label: "Session Status",
		description: "Orient yourself in the current conversation: where you are, what kind of chat this is, and what messaging actions are available here.",
		promptSnippet:
			"session_status(): check your current conversation context and available messaging abilities before choosing how to act.",
		promptGuidelines: [
			"Use this when you need to ground yourself in the current chat before taking an action.",
			"It helps you confirm whether you are in a DM or group, which channel you are on, and what message actions are supported here.",
			"It also shows current compaction and pruning settings so you know the shape of the session context you are working inside.",
		],
		parameters: SessionStatusParameters,
			execute: async () => {
				const summary = {
					sessionKey: context.session.sessionKey,
					externalConversationId: context.session.externalConversationId,
					chatKind: context.session.chatKind,
					channelType: context.session.channelType === "napcat" ? "qq" : context.session.channelType,
					capabilities: context.capabilities,
					inboundMessageId: context.event.messageId,
					replyToMessageId: context.event.replyToMessageId,
					availableChannels: context.runtimeDirectory.availableChannels,
					compaction: {
						enabled: Boolean(SESSION_COMPACTION_SETTINGS.enabled),
						reserveTokens: SESSION_COMPACTION_SETTINGS.reserveTokens,
						keepRecentTokens: SESSION_COMPACTION_SETTINGS.keepRecentTokens,
					},
					pruning: {
						enabled: SESSION_PRUNING_ENABLED,
						protectedRecentAssistantMessages: SESSION_PRUNING_PROTECTED_ASSISTANT_MESSAGES,
						oversizedThresholdChars: SESSION_PRUNING_OVERSIZED_RESULT_CHARS,
						toolResultBudgetChars: SESSION_PRUNING_TOOL_RESULT_BUDGET_CHARS,
					},
				};
			return {
				content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
				details: summary,
			};
		},
	};
}

function createNoReplyTool(context: ChannelToolContext): ToolDefinition {
	return {
		name: "no_reply",
		label: "No Reply",
		description: "Explicitly suppress the default assistant reply for the current inbound message.",
		promptSnippet:
			"no_reply(): intentionally send nothing back for this inbound message when silence is the correct behavior.",
		parameters: NoReplyParameters,
		execute: async () => {
			context.recordAction({ kind: "no_reply" });
			return {
				content: [{ type: "text", text: "Default reply suppressed for the current session." }],
				details: { kind: "no_reply" },
			};
		},
	};
}

export function createNekoclawTools(context: ChannelToolContext): ToolDefinition[] {
	const tools = [
		createMessageTool(context),
		createListContactsTool(context),
		createListGroupsTool(context),
		createGetGroupMembersTool(context),
		createGetContactDetailTool(context),
		createSendMessageTool(context),
		createSessionStatusTool(context),
	];
	if (shouldExposeNoReplyTool(context)) {
		tools.push(createNoReplyTool(context));
	}
	return tools;
}

export function createToolComposition(context: ChannelToolContext, channelTools: ToolDefinition[] = []): {
	codingTools: typeof codingTools;
	nekoclawTools: ToolDefinition[];
	channelTools: ToolDefinition[];
	customTools: ToolDefinition[];
} {
	const nekoclawTools = createNekoclawTools(context);
	return {
		codingTools,
		nekoclawTools,
		channelTools,
		customTools: [...nekoclawTools, ...channelTools],
	};
}

function shouldExposeNoReplyTool(context: ChannelToolContext): boolean {
	return context.event.chatKind !== "dm";
}
