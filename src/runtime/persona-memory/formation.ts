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
		"If index.md still contains only the initial bootstrap placeholder, replace that placeholder with a real routed index in this run instead of leaving it untouched.",
		"All route paths written inside index.md are worker-facing paths, not maintenance-local shortcuts.",
		"Write index links as .nekoclaw-persona/memory/... so a later worker can read them directly.",
		"Do not write maintenance-local relative paths like memory/... inside index.md.",
		"Example: correct `.nekoclaw-persona/memory/people/xiao-wang.md`; incorrect `memory/people/xiao-wang.md`.",
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
		"- Every index.md route path must use the .nekoclaw-persona/... worker-facing form.",
		"- Preserve corrections, identity links, uncertainty, and whether you observed or participated.",
		"- Prioritize durable facts that future replies are likely to need, not low-value chatter.",
		"- Write memory in concise natural Chinese Markdown, not in English meeting-minutes style summaries.",
		"",
		"Prioritize sedimenting these timeline signals when they appear:",
		"- User identity corrections and links: who someone is, who they are not, aliases, handles, relationships, and cross-scene identity joins.",
		"- Long-term defaults and standing preferences, especially requests like '以后默认...', '记住...', '下次直接按...'.",
		"- Bot-visible commitments and obligations stated in Bot turns, including promises, agreed follow-ups, and default choices the bot confirmed.",
		"- Stable person/scene facts that explain later callbacks such as projects, conflicts, ongoing tasks, or group context.",
		"- Stable personality signals for active people: temperament, speaking style, recurring sentence particles, catchphrases, or how they usually phrase things, but only when repeated evidence supports it.",
		"- Stable scene signals: what kind of group/scene this is, what people usually talk about here, the overall vibe, and who the active or central people are.",
		"",
		"De-prioritize or omit:",
		"- Small talk, filler, generic politeness, and stylistic phrasing with no future recall value.",
		"- Ephemeral wording that does not change identity, commitments, defaults, or ongoing situation.",
		"- Duplicate paraphrases when an existing memory file already captures the same durable fact.",
		"- One-off screenshot timestamps, isolated quips, and low-value chronological diary details.",
		"- Creating a dedicated people file for a minor passerby who only appeared briefly and has no durable future value.",
		"",
		"People memory requirements:",
		"- Do not create or significantly expand a people file unless the person is active enough or important enough to matter later.",
		"- A person is worth long-term memory when they are repeatedly active, span multiple sessions, have ongoing work or defaults, have direct bot commitments/corrections, or have a stable recognizable style that will help later replies.",
		"- When evidence is strong enough, record personality, tone, speaking habits, or catchphrases as durable impressions. Do not upgrade a single joke into a stable trait.",
		"",
		"Scene memory requirements:",
		"- Scene memory should tell a future reader what this scene is, what people usually talk about here, what the vibe feels like, who the active people are, and whether the bot mostly observed or participated.",
		"- Scene memory should read like a useful long-term scene profile, not like a day-by-day transcript or meeting log.",
		"",
		"Index quality requirement:",
		"- Update index.md summaries so the worker can notice that a detailed file is worth opening later.",
		"- Keep index.md short and route-oriented. Use one high-signal cue per entry instead of repeating whole people/scenes files.",
		"- If a future query might sound like '你答应过什么' or '默认按哪个', leave enough cue text in index.md to route the worker to the right detailed file.",
		"- Keep route paths worker-readable: `.nekoclaw-persona/memory/...`, never bare `memory/...`.",
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
		"Inspect .nekoclaw-persona/index.md, the scene observation log, and any relevant memory files you need.",
		"If index.md still contains only the initial bootstrap placeholder, replace that placeholder with a real routed index in this run instead of leaving it untouched.",
		"Revise existing files and create new people/scenes files only when necessary.",
		"Keep every index.md person and scene entry path-bearing so the worker can read the detailed file later.",
		"All route paths written inside index.md are worker-facing paths. Use `.nekoclaw-persona/memory/...`, not bare `memory/...`.",
		"Example: correct `.nekoclaw-persona/memory/scenes/telegram-group-1001.md`; incorrect `memory/scenes/telegram-group-1001.md`.",
		"Preserve corrections, identity links, uncertainty, and whether the bot was only observing.",
		"Write memory in concise natural Chinese Markdown, not in English meeting-minutes style summaries.",
		"Prioritize durable defaults, commitments, identity corrections, stable project/relationship facts, stable personality signals for active people, and stable scene vibe/context over small talk.",
		"Only create people files for people who are active enough or important enough to matter later; brief passersby should stay in scene memory or observations only.",
		"Scene memory should capture what kind of group/scene this is, what people usually talk about here, the vibe, and who is active.",
		"Update index.md summaries so later worker recall can route into the right detailed file without repeating whole memory files.",
		"Observation line format: [ISO_TIMESTAMP] channelType:senderId displayName | scene=Chat Title: content",
		"The scene=... segment is present on grouped observations when a human-readable group title is known.",
		`Primary observation file: .nekoclaw-persona/observations/${input.sceneRef}.log`,
		"Finalize protocol (strict): persona_finalize must be called exactly once, and only after all file edits are complete. If nothing changed, still call it exactly once with consumeObservationLines=0. After calling persona_finalize, stop immediately and do not use more tools.",
		"",
		"Memory files manifest:",
		input.memoryManifestText,
		"",
		"When all edits are complete, call persona_finalize exactly once with the number of observation lines that were fully incorporated into memory files.",
	].join("\n");
}
