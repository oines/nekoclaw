import type { InboundMessageEvent, MessageContentBlock, ReplyPayload } from "./types.js";

export function getEventText(event: InboundMessageEvent): string {
	return event.blocks
		.filter((block): block is Extract<MessageContentBlock, { kind: "text" }> => block.kind === "text")
		.map((block) => block.text.trim())
		.filter(Boolean)
		.join("\n")
		.trim();
}

export function summarizeBlocks(blocks: MessageContentBlock[]): string[] {
	return blocks.map((block) => {
		switch (block.kind) {
			case "text":
				return `- Text: ${block.text}`;
			case "image":
				return `- Image: ${block.attachment?.relativePath ?? block.name ?? block.remoteId ?? "(unresolved image)"}`;
			case "file":
				return `- File: ${block.attachment?.relativePath ?? block.name ?? block.remoteId ?? "(unresolved file)"}`;
		}
	});
}

function normalizeMentionUsername(username: string): string {
	const trimmed = username.trim();
	if (!trimmed) {
		return "";
	}
	return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}

function normalizeMentionId(event: Pick<InboundMessageEvent, "channelType">, value: string): string {
	const trimmed = value.trim();
	if (!trimmed) {
		return "";
	}
	return event.channelType === "napcat" ? `qq:${trimmed}` : `${event.channelType}:${trimmed}`;
}

export function formatInboundMentionTargets(
	event: Pick<InboundMessageEvent, "channelType" | "mentionedUserIds" | "mentionedUsernames">,
): string[] {
	const values = [
		...(event.mentionedUsernames ?? []).map(normalizeMentionUsername),
		...(event.mentionedUserIds ?? []).map((value) => normalizeMentionId(event, value)),
	].filter(Boolean);
	return Array.from(new Set(values));
}

export function summarizeInboundEvent(event: Pick<InboundMessageEvent, "channelType" | "mentionedUserIds" | "mentionedUsernames" | "blocks">): string[] {
	const mentionTargets = formatInboundMentionTargets(event);
	return [
		...(mentionTargets.length > 0 ? [`- Mentions: ${mentionTargets.join(", ")}`] : []),
		...summarizeBlocks(event.blocks),
	];
}

export function hasOutboundContent(message: ReplyPayload): boolean {
	return Boolean(message.text?.trim()) || Boolean(message.attachments?.length);
}
