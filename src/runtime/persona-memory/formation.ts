import type { InboundMessageEvent } from "../../types.js";
import { collectEventText } from "./observations.js";

export function buildFormationTurnPrompt(input: {
	sceneRef: string;
	event: InboundMessageEvent;
	replyText: string;
	sceneMemoryPath: string;
	memoryManifestText: string;
}): string {
	return [
		`Maintain persona memory for scene ${input.sceneRef}.`,
		"",
		"Use tools to inspect and revise the temporary persona workspace.",
		"Required files to inspect:",
		"- index.md",
		`- observations/${input.sceneRef}.log`,
		`- ${input.sceneMemoryPath} (if it exists)`,
		"",
		`Current inbound message:\n${collectEventText(input.event) || "(empty)"}`,
		"",
		`Actual reply that was sent:\n${input.replyText || "(none)"}`,
		"",
		"Goals:",
		"- Preserve persona memory as Markdown prose.",
		"- Update index.md and any relevant people/scenes files using edit.",
		"- You may create a new people/scenes file with write if needed.",
		"- Ensure every people/scenes file you touch has YAML frontmatter with stable title and a concise description for recall.",
		"- Keep every index.md person and scene entry path-bearing so the worker can read the detailed file later.",
		"- Do not delete files.",
		"- Preserve corrections, identity links, uncertainty, and whether you observed or participated.",
		"",
		"Memory files manifest:",
		input.memoryManifestText,
		"",
		"- When you finish, call persona_finalize with the number of observation lines from this scene log that were fully incorporated.",
	].join("\n");
}

export function buildFormationBacklogPrompt(input: {
	sceneRef: string;
	memoryManifestText: string;
}): string {
	return [
		`Maintain persona memory for scene ${input.sceneRef} from backlog observations.`,
		"",
		"Inspect index.md, the scene observation log, and any relevant memory files you need.",
		"Revise existing files with edit, create new people/scenes files with write when necessary, and do not delete files.",
		"Any people/scenes file you touch should end with YAML frontmatter plus natural-language Markdown body.",
		"Keep every index.md person and scene entry path-bearing so the worker can read the detailed file later.",
		"Preserve corrections, identity links, uncertainty, and whether the bot was only observing.",
		`Primary observation file: observations/${input.sceneRef}.log`,
		"",
		"Memory files manifest:",
		input.memoryManifestText,
		"",
		"When finished, call persona_finalize with how many observation lines were fully incorporated.",
	].join("\n");
}
