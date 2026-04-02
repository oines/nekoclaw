import { describe, expect, it } from "vitest";
import type { Message } from "@mariozechner/pi-ai";
import {
	SESSION_PRUNING_CLEARED_PLACEHOLDER,
	SESSION_PRUNING_TRUNCATED_PLACEHOLDER_PREFIX,
	shapeSessionMessagesForPrompt,
} from "../src/runtime/session-hygiene.js";

function createAssistantMessage(index: number): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text: `assistant-${index}` }],
		api: "openai-completions",
		provider: "openai",
		model: "gpt-5",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason: "stop",
		timestamp: index,
	};
}

function createToolResult(index: number, text: string): Message {
	return {
		role: "toolResult",
		toolCallId: `tool-${index}`,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: index,
	};
}

describe("session hygiene shaping", () => {
	it("soft-trims old oversized tool results without touching newer protected results", () => {
		const oldText = "A".repeat(9_100);
		const protectedText = "B".repeat(9_100);
		const messages: Message[] = [
			{ role: "user", content: "hello", timestamp: 1 },
			createToolResult(2, oldText),
			createAssistantMessage(3),
			createAssistantMessage(4),
			createAssistantMessage(5),
			createToolResult(6, protectedText),
		];

		const shaped = shapeSessionMessagesForPrompt(messages);
		const oldToolResult = shaped[1];
		const protectedToolResult = shaped[5];

		expect(oldToolResult?.role).toBe("toolResult");
		expect(oldToolResult && oldToolResult.role === "toolResult" ? oldToolResult.content[0]?.type : undefined).toBe("text");
		expect(
			oldToolResult && oldToolResult.role === "toolResult" && oldToolResult.content[0]?.type === "text"
				? oldToolResult.content[0].text
				: "",
		).toContain(SESSION_PRUNING_TRUNCATED_PLACEHOLDER_PREFIX);
		expect(protectedToolResult).toEqual(messages[5]);
		expect(messages[1] && messages[1].role === "toolResult" ? messages[1].content[0]?.type : undefined).toBe("text");
		expect(
			messages[1] && messages[1].role === "toolResult" && messages[1].content[0]?.type === "text"
				? messages[1].content[0].text
				: "",
		).toBe(oldText);
	});

	it("hard-clears the oldest oversized tool results when the remaining budget is still too large", () => {
		const oversized = "X".repeat(9_500);
		const messages: Message[] = [
			{ role: "user", content: "hello", timestamp: 1 },
			createToolResult(2, oversized),
			createToolResult(3, oversized),
			createToolResult(4, oversized),
			createToolResult(5, oversized),
			createAssistantMessage(6),
			createAssistantMessage(7),
			createAssistantMessage(8),
		];

		const shaped = shapeSessionMessagesForPrompt(messages);
		const firstTool = shaped[1];
		const secondTool = shaped[2];
		const thirdTool = shaped[3];
		const fourthTool = shaped[4];

		expect(firstTool?.role).toBe("toolResult");
		expect(
			firstTool && firstTool.role === "toolResult" && firstTool.content[0]?.type === "text"
				? firstTool.content[0].text
				: "",
		).toBe(SESSION_PRUNING_CLEARED_PLACEHOLDER);
		expect(
			secondTool && secondTool.role === "toolResult" && secondTool.content[0]?.type === "text"
				? secondTool.content[0].text
				: "",
		).toContain(SESSION_PRUNING_TRUNCATED_PLACEHOLDER_PREFIX);
		expect(
			thirdTool && thirdTool.role === "toolResult" && thirdTool.content[0]?.type === "text"
				? thirdTool.content[0].text
				: "",
		).toContain(SESSION_PRUNING_TRUNCATED_PLACEHOLDER_PREFIX);
		expect(
			fourthTool && fourthTool.role === "toolResult" && fourthTool.content[0]?.type === "text"
				? fourthTool.content[0].text
				: "",
		).toContain(SESSION_PRUNING_TRUNCATED_PLACEHOLDER_PREFIX);
	});

	it("leaves non-text and non-tool messages untouched", () => {
		const messages: Message[] = [
			{ role: "user", content: "hello", timestamp: 1 },
			{
				role: "toolResult",
				toolCallId: "tool-image",
				toolName: "read",
				content: [
					{ type: "text", text: "Read image file [image/jpeg]" },
					{ type: "image", data: "abc", mimeType: "image/jpeg" },
				],
				isError: false,
				timestamp: 2,
			},
			createAssistantMessage(3),
			createAssistantMessage(4),
			createAssistantMessage(5),
		];

		const shaped = shapeSessionMessagesForPrompt(messages);
		expect(shaped).toEqual(messages);
	});
});
