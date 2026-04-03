import { createHash } from "node:crypto";
import { summarizeBlocks } from "../../messages.js";
import type { InboundMessageEvent, ReplyPayload, SessionRecord } from "../../types.js";
import { FORMATION_MAX_WAIT_MS, FORMATION_MIN_OBSERVATION_LINES, SCENE_OBSERVATION_MAX_LINES, SCENE_OBSERVATION_TOKEN_BUDGET } from "./constants.js";

function estimateTokens(value: string): number {
	return Math.ceil(value.length / 4);
}

export function trimToTokenBudget(value: string, budget: number): string {
	if (estimateTokens(value) <= budget) {
		return value;
	}
	const lines = value.split(/\r?\n/);
	const kept: string[] = [];
	let used = 0;
	for (const line of lines) {
		const lineCost = estimateTokens(line) + 1;
		if (used + lineCost > budget) {
			break;
		}
		kept.push(line);
		used += lineCost;
	}
	return kept.join("\n").trim();
}

export function takeTailLinesWithinBudget(value: string, maxLines = SCENE_OBSERVATION_MAX_LINES, tokenBudget = SCENE_OBSERVATION_TOKEN_BUDGET): string {
	const lines = value
		.split(/\r?\n/)
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0);
	const selected: string[] = [];
	let used = 0;
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index]!;
		const cost = estimateTokens(line) + 1;
		if (selected.length >= maxLines || used + cost > tokenBudget) {
			break;
		}
		selected.unshift(line);
		used += cost;
	}
	return selected.join("\n");
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

export function formatObservationLine(event: InboundMessageEvent): string {
	const speaker = `${event.channelType}:${event.sender.externalId ?? event.chatId}`;
	const displayName = event.sender.displayName ? ` ${event.sender.displayName}` : "";
	const content = collectEventText(event).replace(/\n+/g, " ").trim();
	return `[${event.occurredAt}] ${speaker}${displayName}: ${content}`;
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
