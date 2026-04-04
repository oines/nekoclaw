import { createHash } from "node:crypto";
import { summarizeBlocks } from "../../messages.js";
import type { TokenCountResult } from "../token-service.js";
import type { InboundMessageEvent, ReplyPayload, SessionRecord } from "../../types.js";
import { FORMATION_MAX_WAIT_MS, FORMATION_MIN_OBSERVATION_LINES, SCENE_OBSERVATION_MAX_LINES, SCENE_OBSERVATION_TOKEN_BUDGET } from "./constants.js";

export type CountTextTokens = (value: string) => Promise<TokenCountResult>;

async function fitLargestPrefix(lines: string[], budget: number, countTextTokens: CountTextTokens | undefined): Promise<string> {
	const joined = lines.join("\n").trim();
	if (!joined || !countTextTokens) {
		return joined;
	}
	const total = await countTextTokens(joined);
	if (!total.available || total.tokens <= budget) {
		return joined;
	}
	let low = 0;
	let high = lines.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		const candidate = lines.slice(0, mid).join("\n").trim();
		const counted = await countTextTokens(candidate);
		if (counted.available && counted.tokens <= budget) {
			low = mid;
		} else {
			high = mid - 1;
		}
	}
	return lines.slice(0, low).join("\n").trim();
}

async function fitLargestTail(lines: string[], budget: number, countTextTokens: CountTextTokens | undefined): Promise<string> {
	const joined = lines.join("\n");
	if (!joined || !countTextTokens) {
		return joined;
	}
	const total = await countTextTokens(joined);
	if (!total.available || total.tokens <= budget) {
		return joined;
	}
	let low = 0;
	let high = lines.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		const candidate = lines.slice(-mid).join("\n");
		const counted = await countTextTokens(candidate);
		if (counted.available && counted.tokens <= budget) {
			low = mid;
		} else {
			high = mid - 1;
		}
	}
	return lines.slice(-low).join("\n");
}

export async function trimToTokenBudget(value: string, budget: number, countTextTokens?: CountTextTokens): Promise<string> {
	if (!countTextTokens || !value.trim()) {
		return value;
	}
	const lines = value.split(/\r?\n/);
	return await fitLargestPrefix(lines, budget, countTextTokens);
}

export async function takeTailLinesWithinBudget(
	value: string,
	maxLines = SCENE_OBSERVATION_MAX_LINES,
	tokenBudget = SCENE_OBSERVATION_TOKEN_BUDGET,
	countTextTokens?: CountTextTokens,
): Promise<string> {
	const lines = value
		.split(/\r?\n/)
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0);
	const capped = lines.slice(-maxLines);
	return await fitLargestTail(capped, tokenBudget, countTextTokens);
}

function slugSegment(value: string | undefined): string {
	const normalized = (value ?? "unknown")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return normalized || "unknown";
}

export function buildSceneRef(session: SessionRecord | undefined, event: InboundMessageEvent): string {
	const threadPart = session?.threadId ? `-${slugSegment(session.threadId)}` : "";
	return `${event.channelType}-${event.chatKind}-${slugSegment(event.chatId)}${threadPart}`;
}

export function buildSceneMemoryPath(sceneRef: string): string {
	return `memory/scenes/${sceneRef}.md`;
}

export function collectReplyText(payload: ReplyPayload | undefined): string {
	return payload?.text?.trim() || "";
}

export function collectEventText(event: InboundMessageEvent): string {
	return summarizeBlocks(event.blocks).join("\n").trim();
}

export function normalizeText(value: string | undefined): string {
	return value?.trim() || "";
}

function toExposedChannelType(channelType: string): string {
	return channelType === "napcat" ? "qq" : channelType;
}

export function formatObservationLine(event: InboundMessageEvent): string {
	const speaker = `${toExposedChannelType(event.channelType)}:${event.sender.externalId ?? event.chatId}`;
	const displayName = event.sender.displayName ? ` ${event.sender.displayName}` : "";
	const sceneLabel =
		event.chatKind === "group" && event.chatTitle?.trim()
			? ` | scene=${event.chatTitle.trim()}`
			: "";
	const content = collectEventText(event).replace(/\n+/g, " ").trim();
	return `[${event.occurredAt}] ${speaker}${displayName}${sceneLabel}: ${content}`;
}

export function parseObservationTimestamp(line: string): number | undefined {
	const match = line.match(/^\[([^\]]+)\]/);
	if (!match?.[1]) {
		return undefined;
	}
	const timestamp = Date.parse(match[1]);
	return Number.isNaN(timestamp) ? undefined : timestamp;
}

export function shouldRunFormationForObservations(observationLines: string[], referenceTimeMs: number): boolean {
	if (observationLines.length === 0) {
		return false;
	}
	if (observationLines.length >= FORMATION_MIN_OBSERVATION_LINES) {
		return true;
	}
	const oldestTimestamp = parseObservationTimestamp(observationLines[0]!);
	if (oldestTimestamp === undefined) {
		return true;
	}
	return referenceTimeMs - oldestTimestamp >= FORMATION_MAX_WAIT_MS;
}

export function buildObservationSignature(observationLines: string[]): string {
	return createHash("sha256").update(observationLines.join("\n")).digest("hex");
}
