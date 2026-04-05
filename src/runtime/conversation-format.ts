export interface ReplyContextSummary {
	speakerName?: string;
	summary: string;
}

export function normalizeSpeakerName(value: string | undefined, fallback = "Unknown"): string {
	return value?.trim() || fallback;
}

function normalizeSummaryLine(value: string): string {
	return value.replace(/^\s*-\s*/, "").replace(/\s+/g, " ").trim();
}

export function collapseSummaryLines(lines: string[]): string {
	return lines
		.map((line) => normalizeSummaryLine(line))
		.filter(Boolean)
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
}

export function buildSpeakerLine(speakerName: string | undefined, summary: string): string {
	const normalizedSpeaker = normalizeSpeakerName(speakerName);
	return `${normalizedSpeaker}: ${summary}`.trim();
}

export function buildSpeakerReplyLine(speakerName: string | undefined, replyContext: ReplyContextSummary): string {
	const normalizedSpeaker = normalizeSpeakerName(speakerName);
	const targetSpeaker = normalizeSpeakerName(replyContext.speakerName);
	return `${normalizedSpeaker} reply_to ${targetSpeaker}: ${replyContext.summary}`.trim();
}

export function buildReplyToClause(replyContext: ReplyContextSummary): string {
	const targetSpeaker = normalizeSpeakerName(replyContext.speakerName);
	return `reply_to ${targetSpeaker}: ${replyContext.summary}`.trim();
}
