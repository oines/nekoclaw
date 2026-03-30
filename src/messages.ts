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

export function hasOutboundContent(message: ReplyPayload): boolean {
	return Boolean(message.text?.trim()) || Boolean(message.attachments?.length);
}
