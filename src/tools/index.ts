import { randomUUID } from "node:crypto";
import { Type, type Static } from "@sinclair/typebox";
import { codingTools, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import { parseTargetRef } from "../runtime/runtime-directory.js";
import { normalizeTimezone, validateDailyTimePart, validateRunAtLocal } from "../store/cron-schedule.js";
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
	], { description: "Channel action: send (new message in current session), reply (explicit thread reply), edit (update existing message), delete (remove message), typing (show typing indicator)." }),
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
const CronToolParameters = Type.Object({
	action: Type.Union([Type.Literal("create"), Type.Literal("list"), Type.Literal("cancel")]),
	cronId: Type.Optional(Type.String()),
	scheduleKind: Type.Optional(Type.Union([Type.Literal("once"), Type.Literal("daily")])),
	message: Type.Optional(Type.String()),
	runAtLocal: Type.Optional(Type.String({ description: "One-time local wall-clock timestamp like 2026-04-03T07:00." })),
	hour: Type.Optional(Type.Number({ description: "Hour (0-23) for daily reminders." })),
	minute: Type.Optional(Type.Number({ description: "Minute (0-59) for daily reminders." })),
	timezone: Type.Optional(Type.String({ description: "IANA timezone like Asia/Shanghai. Defaults to the server local timezone." })),
});

type MessageToolInput = Static<typeof MessageToolParameters>;
type ListContactsInput = Static<typeof ListContactsParameters>;
type ListGroupsInput = Static<typeof ListGroupsParameters>;
type GetGroupMembersInput = Static<typeof GetGroupMembersParameters>;
type GetContactDetailInput = Static<typeof GetContactDetailParameters>;
type SendMessageInput = Static<typeof SendMessageParameters>;
type CronToolInput = Static<typeof CronToolParameters>;

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
		description: "Advanced actions in the current session only: explicit send, reply, edit, delete, or typing.",
		promptSnippet:
			"message(action, text?, attachments?, replyToId?, messageId?): use only for explicit actions in this current session.",
		promptGuidelines: [
			"Do not use this for a normal current reply. Just output plain text when plain text is enough.",
			"Use this only inside the current session. Never use it to reach another contact or group.",
			"Use action='reply' only when you must explicitly reply to a specific previous message id.",
			"Use action='edit' or action='delete' only with a concrete message id.",
			"Use action='typing' when showing typing is useful before a longer answer.",
			"Examples: current normal reply -> plain text; explicit current-session reply -> message(action='reply', ...); proactive outreach elsewhere -> send_message(target, ...).",
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
		description: "List the runtime-known contacts you can proactively message.",
		promptSnippet:
			"list_contacts(channel?): list known telegram or qq contacts before choosing a proactive message target.",
		promptGuidelines: [
			"Use this before proactive outreach when you do not yet know the exact contact ref.",
			"The result is the runtime-known contact list, not a platform-wide friend list.",
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
		description: "List the runtime-known groups you can inspect or proactively message.",
		promptSnippet:
			"list_groups(channel?): list known telegram or qq groups before messaging a group or inspecting its members.",
		promptGuidelines: [
			"Use this before proactive group outreach when you need the explicit group ref first.",
			"The result is the runtime-known group list, not a platform-wide directory of every group.",
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
		description: "Inspect the runtime-known members for one explicit group ref.",
		promptSnippet:
			"get_group_members(groupRef): inspect the runtime-known members of one explicit group ref.",
		promptGuidelines: [
			"Use this after list_groups when you want to understand who you know in a particular group.",
			"Treat the result as runtime-known membership, not a guaranteed full platform roster.",
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
		description: "Inspect one explicit runtime-known contact before referring to or messaging them.",
		promptSnippet:
			"get_contact_detail(account): inspect one explicit runtime-known contact ref.",
		promptGuidelines: [
			"Use this when you already have a contact ref and want a closer look before messaging or referring to that person.",
			"Treat the result as runtime metadata, not a guaranteed complete identity record.",
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
		description: "Proactively send a message to another known DM or group outside the current session.",
		promptSnippet:
			"send_message(target, text?, attachments?): proactively message another known target outside the current session.",
		promptGuidelines: [
			"Use this only when the target is different from the one you are currently talking to.",
			"Use an explicit target ref like telegram:dm:123 or qq:group:456.",
			"Use list_contacts or list_groups first if you are not sure which target ref to use.",
			"For the current session, either respond in plain text or use message(...) for advanced current-session actions instead.",
			"Examples: proactive note to another DM -> send_message(target, ...); replying here in the current session -> plain text or message(...), not send_message.",
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
			"It confirms whether you are in a DM or group, which channel you are on, and which message actions are supported here.",
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
					timezone: context.serverTimezone,
					activeCronCount: context.sessionCrons.length,
				};
			return {
				content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
				details: summary,
			};
		},
	};
}

function createCronTool(context: ChannelToolContext): ToolDefinition {
	return {
		name: "cron",
		label: "Cron",
		description: "Create, inspect, or cancel reminders that are automatically bound to the current session.",
		promptSnippet:
			"cron(action, ...): create/list/cancel reminders for THIS session only. The session is auto-bound; never provide a session key.",
		promptGuidelines: [
			"Use this when the user asks for a reminder later in this same DM or group.",
			"Default timezone is the server local timezone shown by session_status.",
			"Use action='create' with scheduleKind='once' plus runAtLocal for a one-time reminder, or scheduleKind='daily' plus hour/minute for a daily reminder.",
			"Use action='list' before canceling if you need to inspect active reminders in the current session.",
			"Use action='cancel' with a cronId returned by list. Cancellation stays scoped to the current session.",
		],
		parameters: CronToolParameters,
		execute: async (_toolCallId, params) => {
			const input = params as CronToolInput;
			if (input.action === "list") {
				return {
					content: [{ type: "text", text: JSON.stringify(context.sessionCrons, null, 2) }],
					details: { crons: context.sessionCrons },
				};
			}

			if (input.action === "cancel") {
				const cronId = input.cronId?.trim();
				if (!cronId) {
					throw new Error("cancel requires cronId");
				}
				const cron = context.sessionCrons.find((entry) => entry.cronId === cronId);
				if (!cron) {
					throw new Error(`Unknown cron "${cronId}" in the current session`);
				}
				context.recordAction({
					kind: "cron_cancel",
					cronId,
				});
				return {
					content: [{ type: "text", text: `Queued cancellation for session reminder ${cronId}.` }],
					details: { kind: "cron_cancel", cronId },
				};
			}

			if (input.action !== "create") {
				throw new Error(`Unsupported cron action "${input.action}"`);
			}
			const scheduleKind = input.scheduleKind;
			if (!scheduleKind) {
				throw new Error("create requires scheduleKind");
			}
			const message = input.message?.trim();
			if (!message) {
				throw new Error("create requires message");
			}
			const timezone = normalizeTimezone(input.timezone ?? context.serverTimezone);
			let runAtLocal: string | undefined;
			let hour: number | undefined;
			let minute: number | undefined;
			if (scheduleKind === "once") {
				runAtLocal = validateRunAtLocal(input.runAtLocal ?? "");
			} else {
				hour = validateDailyTimePart("hour", input.hour ?? Number.NaN, 23);
				minute = validateDailyTimePart("minute", input.minute ?? Number.NaN, 59);
			}
			const cronId = randomUUID();
			context.recordAction({
				kind: "cron_create",
				cronId,
				scheduleKind,
				message,
				timezone,
				runAtLocal,
				hour,
				minute,
			});
			return {
				content: [{ type: "text", text: `Queued a ${scheduleKind} reminder for this session.` }],
				details: {
					kind: "cron_create",
					cronId,
					scheduleKind,
					timezone,
					runAtLocal,
					hour,
					minute,
				},
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
		promptGuidelines: [
			"Use this in group chats when silence is intentionally the right response.",
			"Do not use this in DMs. Staying silent in a direct message is almost always wrong.",
			"Calling no_reply is terminal for the current turn. Do not combine it with plain text or any other tool call.",
		],
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
		createCronTool(context),
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
