function formatSceneContext(input: {
	channelType: string;
	chatKind: string;
	chatId: string;
	chatTitle?: string;
	senderId?: string;
	senderDisplayName?: string;
}): string[] {
	const lines = [
		"Scene context for this run:",
		`- Channel: ${input.channelType === "napcat" ? "qq" : input.channelType}`,
		`- Chat kind: ${input.chatKind}`,
		`- Chat id: ${input.chatId}`,
		input.chatTitle?.trim() ? `- Chat title: ${input.chatTitle.trim()}` : undefined,
		input.senderId ? `- Current sender id: ${input.senderId}` : undefined,
		input.senderDisplayName?.trim()
			? `- Current sender display name: ${input.senderDisplayName.trim()}`
			: undefined,
		input.chatKind === "dm"
			? `- This scene is a direct conversation with ${input.senderDisplayName?.trim() || input.senderId || "the current sender"}.`
			: undefined,
	];
	return lines.filter((line): line is string => Boolean(line));
}

export function buildFormationTurnPrompt(input: {
	sceneRef: string;
	recentTimeline: string;
	sceneMemoryPath: string;
	memoryManifestText: string;
	channelType: string;
	chatKind: string;
	chatId: string;
	chatTitle?: string;
	senderId?: string;
	senderDisplayName?: string;
}): string {
	return [
		`Maintain persona memory for scene ${input.sceneRef}.`,
		"",
		"Task: inspect the temporary persona workspace and update memory for this scene.",
		...formatSceneContext(input),
		"",
		"Inspect first:",
		"- index.md",
		`- observations/${input.sceneRef}.log`,
		`- ${input.sceneMemoryPath} (if it exists)`,
		"",
		"Observation line format: [ISO_TIMESTAMP] channelType:senderId displayName | scene=Chat Title: content",
		"The scene=... segment is present on grouped observations when a human-readable group title is known.",
		"The last line in the observation file is the message that just triggered this formation run.",
		"Recent visible timeline for this scene:",
		input.recentTimeline || "(none)",
		"Timeline semantics: User is the current triggering message, Observed are other inbound messages from the recent session window, and Bot are real visible bot replies in chronological order.",
		"Observed lines are evidence only; do not rewrite them as if the bot participated unless the timeline also shows a Bot turn.",
		"",
		"Goals:",
		"- Update index.md and the relevant people/scenes files for what changed in this scene.",
		"- Keep memory grounded in what was actually observed in the log and in the recent timeline.",
		"- Keep every index.md person and scene entry path-bearing so the worker can read detailed files later.",
		"- Preserve corrections, identity links, uncertainty, and whether you observed or participated.",
		"- Prioritize durable facts that future replies are likely to need, not low-value chatter.",
		"",
		"Prioritize sedimenting these timeline signals when they appear:",
		"- User identity corrections and links: who someone is, who they are not, aliases, handles, relationships, and cross-scene identity joins.",
		"- Long-term defaults and standing preferences, especially requests like '以后默认...', '记住...', '下次直接按...'.",
		"- Bot-visible commitments and obligations stated in Bot turns, including promises, agreed follow-ups, and default choices the bot confirmed.",
		"- Stable person/scene facts that explain later callbacks such as projects, conflicts, ongoing tasks, or group context.",
		"",
		"De-prioritize or omit:",
		"- Small talk, filler, generic politeness, and stylistic phrasing with no future recall value.",
		"- Ephemeral wording that does not change identity, commitments, defaults, or ongoing situation.",
		"- Duplicate paraphrases when an existing memory file already captures the same durable fact.",
		"",
		"Index quality requirement:",
		"- Update index.md summaries so the worker can notice that a detailed file is worth opening later.",
		"- If a future query might sound like '你答应过什么' or '默认按哪个', leave enough cue text in index.md to route the worker to the right detailed file.",
		"",
		"Finalize protocol (strict):",
		"- persona_finalize must be called exactly once, and only after all file edits are complete.",
		"- If this run does not change any memory files, you must still call persona_finalize exactly once with consumeObservationLines=0.",
		"- After calling persona_finalize, stop immediately and do not use any more tools.",
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
		"Prioritize durable defaults, commitments, identity corrections, and stable project/relationship facts over small talk.",
		"Update index.md summaries so later worker recall can route into the right detailed file.",
		"Observation line format: [ISO_TIMESTAMP] channelType:senderId displayName | scene=Chat Title: content",
		"The scene=... segment is present on grouped observations when a human-readable group title is known.",
		`Primary observation file: observations/${input.sceneRef}.log`,
		"Finalize protocol (strict): persona_finalize must be called exactly once, and only after all file edits are complete. If nothing changed, still call it exactly once with consumeObservationLines=0. After calling persona_finalize, stop immediately and do not use more tools.",
		"",
		"Memory files manifest:",
		input.memoryManifestText,
		"",
		"When all edits are complete, call persona_finalize exactly once with the number of observation lines that were fully incorporated into memory files.",
	].join("\n");
}
