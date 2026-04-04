import { parseAddressedSlashCommand } from "../command-parsing.js";
import { summarizeBlocks } from "../messages.js";
import type { ChatKind, ChannelType, InboundMessageEvent, ReplyPayload, SessionRecord } from "../types.js";
import { FORMATION_TIMELINE_MAX_EVENTS, FORMATION_TIMELINE_TOKEN_BUDGET } from "./persona-memory/constants.js";

export type BotOutboundLogSource = "outbound" | "tool.reply" | "tool.send" | "tool.send_targeted";

export interface SessionInboundLogEntry extends InboundMessageEvent {
	timestamp: string;
	type: InboundMessageEvent["eventType"];
	channel: ChannelType;
}

export interface SessionBotOutboundLogEntry {
	timestamp: string;
	type: "bot.outbound";
	channel: ChannelType;
	channelType: ChannelType;
	chatId: string;
	chatKind: ChatKind;
	chatTitle?: string;
	sessionRecordId: string;
	sender: {
		externalId: "__bot__";
		displayName?: string;
	};
	payload: ReplyPayload;
	source: BotOutboundLogSource;
}

export type SessionLogEntry = SessionInboundLogEntry | SessionBotOutboundLogEntry;

function estimateTokens(value: string): number {
	return Math.ceil(value.length / 4);
}

function toExposedChannelType(channelType: ChannelType): string {
	return channelType === "napcat" ? "qq" : channelType;
}

export function summarizeReplyPayload(payload: ReplyPayload): string[] {
	const lines: string[] = [];
	if (payload.text?.trim()) {
		lines.push(`- Text: ${payload.text.trim()}`);
	}
	for (const att of payload.attachments ?? []) {
		lines.push(`- ${att.kind === "image" ? "Image" : "File"}: ${att.name ?? att.mimeType ?? "attachment"}`);
	}
	return lines;
}

export function buildInboundSessionLogEntry(event: InboundMessageEvent): SessionInboundLogEntry {
	return {
		timestamp: event.occurredAt,
		type: event.eventType,
		channel: event.channelType,
		...event,
	};
}

export function buildBotOutboundSessionLogEntry(input: {
	timestamp: string;
	session: Pick<SessionRecord, "sessionRecordId" | "channelType" | "externalConversationId" | "chatKind" | "chatTitle">;
	payload: ReplyPayload;
	source: BotOutboundLogSource;
	botDisplayName?: string;
}): SessionBotOutboundLogEntry {
	return {
		timestamp: input.timestamp,
		type: "bot.outbound",
		channel: input.session.channelType,
		channelType: input.session.channelType,
		chatId: input.session.externalConversationId,
		chatKind: input.session.chatKind,
		chatTitle: input.session.chatTitle,
		sessionRecordId: input.session.sessionRecordId,
		sender: {
			externalId: "__bot__",
			displayName: input.botDisplayName,
		},
		payload: input.payload,
		source: input.source,
	};
}

export function isBotOutboundSessionLogEntry(entry: SessionLogEntry | unknown): entry is SessionBotOutboundLogEntry {
	return Boolean(entry && typeof entry === "object" && (entry as { type?: unknown }).type === "bot.outbound");
}

export function isInboundSessionLogEntry(entry: SessionLogEntry | unknown): entry is SessionInboundLogEntry {
	if (!entry || typeof entry !== "object") {
		return false;
	}
	const type = (entry as { type?: unknown }).type;
	return type === "message.created" || type === "message.updated" || type === "message.deleted";
}

function isSameInboundEvent(entry: SessionInboundLogEntry, event: InboundMessageEvent): boolean {
	return (
		entry.messageId === event.messageId &&
		entry.chatId === event.chatId &&
		entry.channelType === event.channelType &&
		entry.eventType === event.eventType &&
		entry.occurredAt === event.occurredAt
	);
}

function isSlashCommandEntry(entry: SessionInboundLogEntry): boolean {
	if (!entry.blocks?.length) {
		return false;
	}
	return Boolean(parseAddressedSlashCommand(entry));
}

function buildInboundHeader(entry: SessionInboundLogEntry, speaker: "User" | "Observed"): string {
	const parts = [`${toExposedChannelType(entry.channelType)}:${entry.sender.externalId ?? entry.chatId}`];
	if (entry.sender.displayName?.trim()) {
		parts.push(entry.sender.displayName.trim());
	}
	if (entry.chatKind === "group" && entry.chatTitle?.trim()) {
		parts.push(`scene=${entry.chatTitle.trim()}`);
	}
	return `[${entry.occurredAt}] ${speaker} (${parts.join(" | ")}):`;
}

function buildBotHeader(entry: SessionBotOutboundLogEntry): string {
	const parts: string[] = [];
	if (entry.chatKind === "group" && entry.chatTitle?.trim()) {
		parts.push(`scene=${entry.chatTitle.trim()}`);
	}
	if (entry.source) {
		parts.push(`source=${entry.source}`);
	}
	const suffix = parts.length > 0 ? ` (${parts.join(" | ")})` : "";
	return `[${entry.timestamp}] Bot${suffix}:`;
}

function formatTimelineTurn(header: string, lines: string[]): string | undefined {
	if (lines.length === 0) {
		return undefined;
	}
	return `${header}\n${lines.join("\n")}`;
}

function takeTailTurnsWithinBudget(turns: string[], maxEvents = FORMATION_TIMELINE_MAX_EVENTS, tokenBudget = FORMATION_TIMELINE_TOKEN_BUDGET): string {
	const selected: string[] = [];
	let used = 0;
	for (let index = turns.length - 1; index >= 0; index -= 1) {
		const turn = turns[index]!;
		const cost = estimateTokens(turn) + 1;
		if (selected.length >= maxEvents || used + cost > tokenBudget) {
			break;
		}
		selected.unshift(turn);
		used += cost;
	}
	return selected.join("\n\n");
}

export function buildFormationTimeline(input: {
	logEntries: SessionLogEntry[];
	currentEvent: InboundMessageEvent;
	fallbackBotPayloads?: ReplyPayload[];
	maxEvents?: number;
	tokenBudget?: number;
}): string {
	const turns: string[] = [];
	const seenBotPayloads = new Set<string>();

	for (const entry of input.logEntries) {
		if (isBotOutboundSessionLogEntry(entry)) {
			const lines = summarizeReplyPayload(entry.payload);
			const turn = formatTimelineTurn(buildBotHeader(entry), lines);
			if (turn) {
				turns.push(turn);
			}
			if (lines.length > 0) {
				seenBotPayloads.add(lines.join("\n"));
			}
			continue;
		}
		if (!isInboundSessionLogEntry(entry)) {
			continue;
		}
		if (entry.type === "message.deleted" || isSlashCommandEntry(entry)) {
			continue;
		}
		const lines = summarizeBlocks(entry.blocks ?? []);
		const speaker = isSameInboundEvent(entry, input.currentEvent) ? "User" : "Observed";
		const turn = formatTimelineTurn(buildInboundHeader(entry, speaker), lines);
		if (turn) {
			turns.push(turn);
		}
	}

	for (const payload of input.fallbackBotPayloads ?? []) {
		const lines = summarizeReplyPayload(payload);
		if (lines.length === 0) {
			continue;
		}
		const signature = lines.join("\n");
		if (seenBotPayloads.has(signature)) {
			continue;
		}
		turns.push(formatTimelineTurn(`[${input.currentEvent.occurredAt}] Bot (source=current_run_fallback):`, lines)!);
		seenBotPayloads.add(signature);
	}

	return takeTailTurnsWithinBudget(turns, input.maxEvents, input.tokenBudget);
}
