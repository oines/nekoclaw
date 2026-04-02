import type { InternalChatHarnessRunOptions } from "./chat-harness/current-env.js";
import type { InternalChatHarnessReport } from "./chat-harness/current-env.js";
import { runInternalChatHarness } from "./chat-harness.js";

export const PERSONA_HARNESS_SCENARIOS = [
	"persona_group_observation_recall",
	"persona_cross_session_memory",
	"persona_emotional_context_memory",
	"persona_cross_platform_identity",
	"persona_correction",
	"persona_experience_recall",
	"persona_uncertainty",
	"persona_multi_group_experience",
	"persona_memory_decay",
	"persona_dream_cross_scene_association",
	"persona_dream_index_rebuild",
	"persona_dream_global_aging",
	"persona_dream_find_missing_person",
	"persona_dream_preserves_identity",
] as const;

export async function runPersonaHarness(
	options: Omit<InternalChatHarnessRunOptions, "scenario" | "channel"> & { channel?: "both" | "telegram" | "napcat" },
): Promise<InternalChatHarnessReport & { sandboxPath?: string }> {
	return runInternalChatHarness({
		...options,
		channel: options.channel ?? "both",
		scenario: [...PERSONA_HARNESS_SCENARIOS],
		judgeReplies: true,
	});
}
