import type { DreamCorpusSnapshot } from "./types.js";

export function buildDreamSkipKey(reason: string, details: Record<string, unknown>): string {
	return JSON.stringify({ reason, ...details });
}

export function buildDreamPrompt(snapshot: DreamCorpusSnapshot): string {
	return [
		"Perform a Dream pass over the entire persona workspace.",
		"",
		"Task: inspect index.md, the existing people/scenes memory files, and any observations files that help you make cross-scene decisions.",
		"",
		"Dream goals:",
		"- Cross-scene linking for the same person.",
		"- Rebuild index.md as a globally consistent snapshot.",
		"- Remove index.md references to memory files that do not exist anymore.",
		"- Merge duplicate index.md entries for the same person or scene into a single canonical entry.",
		"- Keep every person and scene entry in index.md path-bearing so the worker can read detailed files directly.",
		"- Keep index.md summaries consistent with the current body text of the linked memory files.",
		"- Compress stale low-value memories while preserving core identity and correction details.",
		"- Create missing people files when repeated mentions across scenes justify it.",
		"- You may delete low-value people/scenes files if forgetting them is appropriate, but only after updating index.md so references stay consistent.",
		"- Never invent facts. Keep uncertainty and corrections intact when consolidating memory.",
		"- For stale people files, the rewritten file should be meaningfully shorter than before. Do not add frontmatter, prose cleanup, or archive commentary that makes stale files longer.",
		"- For active people files, preserve current actionable detail instead of compressing them as aggressively as stale files.",
		"- When aging memory, keep only identity, relationships, long-term impressions, and corrections. Remove low-value episodic fragments and outdated incidental detail.",
		"Observation line format (if you read any): [ISO_TIMESTAMP] channelType:senderId displayName: content",
		"",
		"Current corpus snapshot:",
		`- index.md present: ${snapshot.indexSizeBytes > 0 ? "yes" : "no"}`,
		`- people files: ${snapshot.manifest.filter((entry) => entry.kind === "people").length}`,
		`- scene files: ${snapshot.manifest.filter((entry) => entry.kind === "scene").length}`,
		`- observation files: ${snapshot.observations.length}`,
		"",
		"Memory files manifest:",
		snapshot.memoryManifestText,
		"",
		"Call persona_finalize exactly once when you are done. Dream must not consume observations, so always pass consumeObservationLines=0.",
	].join("\n");
}
