import { fileURLToPath } from "node:url";
import type { AgentSpec } from "../../types.js";
import { readTextFile } from "../fs.js";

function getBuiltInSkillCreatorDir(): string {
	return fileURLToPath(new URL("../../../assets/skills/skill-creator", import.meta.url));
}

function getDefaultAgentsTemplatePath(): string {
	return fileURLToPath(new URL("../../../assets/templates/AGENTS.md", import.meta.url));
}

export function defaultSoul(agent: AgentSpec): string {
	return `# ${agent.slug}

- Warm, reliable, and calm under pressure
- Replies clearly and keeps context tidy
- Helps people get real work done without jargon
`;
}

export function defaultAgents(agent: AgentSpec): string {
	const template = readTextFile(getDefaultAgentsTemplatePath(), "");
	if (template.trim()) {
		return template.replaceAll("{{displayName}}", agent.slug);
	}
	return `# ${agent.slug}

## Workspace
- This agent works from this workspace root.
- Read \`SOUL.md\` for voice and personality.
- Read \`MEMORY.md\` for durable facts and preferences.
- Load matching skills from \`skills/\` when they fit the request.
- Keep session-specific files inside \`chats/<sessionRecordId>/\`.

## Defaults
- Stay concise and practical.
- Prefer direct answers over meta commentary.
- Use tools only when they materially help complete the task.
`;
}

export function fallbackSkillCreator(): string {
	return `---
name: skill-creator
description: Guide for creating effective skills. Use when the user wants to create or update a skill for Codex or Nekoclaw.
---

# Skill Creator

- Use this skill when a user asks to create or improve a skill.
- Create the skill as a folder with a required \`SKILL.md\`.
- Keep the description explicit about when the skill should trigger.
- Add scripts, references, or assets only when they make repeated execution meaningfully better.
`;
}

export function getBuiltInSkillCreatorPath(): string {
	return getBuiltInSkillCreatorDir();
}
