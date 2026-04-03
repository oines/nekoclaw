export function buildFormationTurnPrompt(input: {
	sceneRef: string;
	turnTranscript: string;
	sceneMemoryPath: string;
	memoryManifestText: string;
}): string {
	return [
		`Maintain persona memory for scene ${input.sceneRef}.`,
		"",
		"Task: inspect the temporary persona workspace and update memory for this scene.",
		"Inspect first:",
		"- index.md",
		`- observations/${input.sceneRef}.log`,
		`- ${input.sceneMemoryPath} (if it exists)`,
		"",
		"Observation line format: [ISO_TIMESTAMP] channelType:senderId displayName: content",
		"The last line in the observation file is the message that just triggered this formation run.",
		"Full visible transcript for this run:",
		input.turnTranscript || "(none)",
		"",
		"Goals:",
		"- Update index.md and the relevant people/scenes files for what changed in this scene.",
		"- Keep memory grounded in what was actually observed in the log and in this run transcript.",
		"- Keep every index.md person and scene entry path-bearing so the worker can read detailed files later.",
		"- Preserve corrections, identity links, uncertainty, and whether you observed or participated.",
		"",
		"Memory files manifest:",
		input.memoryManifestText,
		"",
		"When all edits are complete, call persona_finalize exactly once with the number of observation lines from this scene log that were fully incorporated into memory files.",
	].join("\n");
}

export function buildFormationBacklogPrompt(input: {
	sceneRef: string;
	memoryManifestText: string;
}): string {
	return [
		`Maintain persona memory for scene ${input.sceneRef} from backlog observations.`,
		"",
		"Task: fold backlog observations from this scene into the relevant memory files.",
		"Inspect index.md, the scene observation log, and any relevant memory files you need.",
		"Revise existing files and create new people/scenes files only when necessary.",
		"Keep every index.md person and scene entry path-bearing so the worker can read the detailed file later.",
		"Preserve corrections, identity links, uncertainty, and whether the bot was only observing.",
		"Observation line format: [ISO_TIMESTAMP] channelType:senderId displayName: content",
		`Primary observation file: observations/${input.sceneRef}.log`,
		"",
		"Memory files manifest:",
		input.memoryManifestText,
		"",
		"When all edits are complete, call persona_finalize exactly once with the number of observation lines that were fully incorporated into memory files.",
	].join("\n");
}
