import { Type, type Static } from "@sinclair/typebox";
import { codingTools, type ToolDefinition } from "@mariozechner/pi-coding-agent";
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

type MessageToolInput = Static<typeof MessageToolParameters>;

const SessionStatusParameters = Type.Object({});
const NoReplyParameters = Type.Object({});

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

function createMessageTool(context: ChannelToolContext): ToolDefinition {
	return {
		name: "message",
		label: "Message",
		description: "Advanced channel actions ONLY: edit, delete, or explicit reply to specific message ID.",
		promptSnippet:
			"message(action, text?, attachments?, replyToId?, messageId?): Use ONLY for explicit system replyToId/edit/delete/typing actions. DO NOT use for normal conversation responses.",
		promptGuidelines: [
			"For normal conversational replies, JUST OUTPUT PLAIN TEXT directly. DO NOT invoke this tool.",
			"Use message(action='reply') ONLY when you must explicitly reply to a specific previous message ID.",
			"Use message(action='typing') to show typing while you prepare a longer answer.",
			"Use message(action='edit'|'delete') with a concrete message id.",
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

function createSessionStatusTool(context: ChannelToolContext): ToolDefinition {
	return {
		name: "session_status",
		label: "Session Status",
		description: "Describe the current session and which messaging actions it supports.",
		promptSnippet:
			"session_status(): inspect the current session, channel capabilities, and reply behavior before using message actions.",
		parameters: SessionStatusParameters,
		execute: async () => {
			const summary = {
				sessionKey: context.session.sessionKey,
				externalConversationId: context.session.externalConversationId,
				chatKind: context.session.chatKind,
				channelType: context.session.channelType,
				capabilities: context.capabilities,
				inboundMessageId: context.event.messageId,
				replyToMessageId: context.event.replyToMessageId,
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
	const tools = [createMessageTool(context), createSessionStatusTool(context)];
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
	return context.event.chatKind !== "dm" && !context.isExplicitlyAddressed;
}
