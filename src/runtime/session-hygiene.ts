import type { Message, TextContent, ToolResultMessage } from "@mariozechner/pi-ai";
import type { CompactionSettings } from "@mariozechner/pi-coding-agent";

export const SESSION_COMPACTION_SETTINGS: Required<CompactionSettings> = {
	enabled: true,
	reserveTokens: 20_000,
	keepRecentTokens: 20_000,
};

export const SESSION_PRUNING_ENABLED = true;
export const SESSION_PRUNING_PROTECTED_ASSISTANT_MESSAGES = 3;
export const SESSION_PRUNING_OVERSIZED_RESULT_CHARS = 8_000;
export const SESSION_PRUNING_SOFT_TRIM_HEAD_CHARS = 1_500;
export const SESSION_PRUNING_SOFT_TRIM_TAIL_CHARS = 1_500;
export const SESSION_PRUNING_TOOL_RESULT_BUDGET_CHARS = 12_000;
export const SESSION_PRUNING_TRUNCATED_PLACEHOLDER_PREFIX = "[Old tool result truncated";
export const SESSION_PRUNING_CLEARED_PLACEHOLDER = "[Old tool result content cleared to control prompt size.]";

function isTextOnlyToolResult(message: Message): message is ToolResultMessage {
	return (
		message.role === "toolResult" &&
		message.content.length > 0 &&
		message.content.every((block) => block.type === "text" && typeof block.text === "string")
	);
}

function measureToolResultChars(message: ToolResultMessage): number {
	return message.content.reduce((total, block) => total + (block.type === "text" ? block.text.length : 0), 0);
}

function softTrimTextContent(text: string): string {
	if (text.length <= SESSION_PRUNING_OVERSIZED_RESULT_CHARS) {
		return text;
	}
	const head = text.slice(0, SESSION_PRUNING_SOFT_TRIM_HEAD_CHARS).trimEnd();
	const tail = text.slice(-SESSION_PRUNING_SOFT_TRIM_TAIL_CHARS).trimStart();
	return `${head}\n\n${SESSION_PRUNING_TRUNCATED_PLACEHOLDER_PREFIX}, original length: ${text.length} chars]\n\n${tail}`;
}

function hardClearTextContent(): string {
	return SESSION_PRUNING_CLEARED_PLACEHOLDER;
}

function cloneTextBlock(block: TextContent, text: string): TextContent {
	return {
		...block,
		text,
	};
}

export function shapeSessionMessagesForPrompt(messages: Message[]): Message[] {
	if (!SESSION_PRUNING_ENABLED || messages.length === 0) {
		return messages;
	}

	const assistantIndexes = messages
		.map((message, index) => (message.role === "assistant" ? index : -1))
		.filter((index) => index >= 0);

	if (assistantIndexes.length < SESSION_PRUNING_PROTECTED_ASSISTANT_MESSAGES) {
		return messages;
	}

	const protectedFromIndex = assistantIndexes[assistantIndexes.length - SESSION_PRUNING_PROTECTED_ASSISTANT_MESSAGES]!;
	const shaped = [...messages];
	const candidates: Array<{ index: number; charsBefore: number; charsAfter: number }> = [];

	for (let index = 0; index < protectedFromIndex; index += 1) {
		const message = shaped[index]!;
		if (!isTextOnlyToolResult(message)) {
			continue;
		}
		const charsBefore = measureToolResultChars(message);
		if (charsBefore <= SESSION_PRUNING_OVERSIZED_RESULT_CHARS) {
			continue;
		}
		const trimmedContent = message.content.map((block, blockIndex) =>
			block.type === "text" && blockIndex === 0 ? cloneTextBlock(block, softTrimTextContent(block.text)) : block,
		);
		const trimmedMessage: ToolResultMessage = {
			...message,
			content: trimmedContent,
		};
		shaped[index] = trimmedMessage;
		candidates.push({
			index,
			charsBefore,
			charsAfter: measureToolResultChars(trimmedMessage),
		});
	}

	let totalChars = shaped.reduce((total, message, index) => {
		if (!isTextOnlyToolResult(message) || index >= protectedFromIndex) {
			return total;
		}
		return total + measureToolResultChars(message);
	}, 0);

	if (totalChars <= SESSION_PRUNING_TOOL_RESULT_BUDGET_CHARS) {
		return shaped;
	}

	for (const candidate of candidates) {
		if (totalChars <= SESSION_PRUNING_TOOL_RESULT_BUDGET_CHARS) {
			break;
		}
		const current = shaped[candidate.index];
		if (!current || !isTextOnlyToolResult(current)) {
			continue;
		}
		const currentChars = measureToolResultChars(current);
		const clearedContent = current.content.map((block, blockIndex) =>
			block.type === "text" && blockIndex === 0 ? cloneTextBlock(block, hardClearTextContent()) : block,
		);
		const clearedMessage: ToolResultMessage = {
			...current,
			content: clearedContent,
		};
		shaped[candidate.index] = clearedMessage;
		totalChars = totalChars - currentChars + measureToolResultChars(clearedMessage);
	}

	return shaped;
}
