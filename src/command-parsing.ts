import { getEventText } from "./messages.js";
import type { InboundMessageEvent } from "./types.js";

const COMMAND_TOKEN_RE = /^\/([a-z]+)(?:@[\w_]+)?$/i;
const LEADING_MENTION_TOKEN_RE = /^@\S+$/u;

export type ParsedSlashCommandLine = {
	command: string;
	commandToken: string;
	args: string[];
};

export function isExplicitlyAddressedEvent(event: InboundMessageEvent): boolean {
	return (
		(event.mentionedUsernames?.length ?? 0) > 0 ||
		(event.mentionedUserIds?.length ?? 0) > 0 ||
		Boolean(event.isReplyToBot)
	);
}

export function parseAddressedSlashCommand(event: InboundMessageEvent): ParsedSlashCommandLine | undefined {
	const text = getEventText(event).trim();
	if (!text) {
		return undefined;
	}
	const [firstLine] = text.split(/\r?\n/, 1);
	const tokens = firstLine.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) {
		return undefined;
	}
	const commandIndex = tokens.findIndex((token) => COMMAND_TOKEN_RE.test(token));
	if (commandIndex < 0) {
		return undefined;
	}
	if (commandIndex > 0 && !hasAddressingPrefix(tokens.slice(0, commandIndex), event)) {
		return undefined;
	}
	const commandToken = tokens[commandIndex];
	if (!commandToken) {
		return undefined;
	}
	const match = COMMAND_TOKEN_RE.exec(commandToken);
	if (!match) {
		return undefined;
	}
	return {
		command: match[1].toLowerCase(),
		commandToken,
		args: tokens.slice(commandIndex + 1),
	};
}

export function isAddressedSlashCommand(
	event: InboundMessageEvent,
	commandName: string,
): boolean {
	const parsed = parseAddressedSlashCommand(event);
	return parsed?.command === commandName.toLowerCase();
}

function hasAddressingPrefix(prefixTokens: string[], event: InboundMessageEvent): boolean {
	if (prefixTokens.length === 0) {
		return true;
	}
	return prefixTokens.every((token) => LEADING_MENTION_TOKEN_RE.test(token));
}
