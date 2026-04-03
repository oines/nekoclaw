import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { AgentSpec } from "./agent.js";
import type { ChannelCapabilities } from "./channel.js";
import type { ChannelToolAction, ReplyPayload } from "./message.js";
import type { RuntimeDirectorySnapshot, PreparedPersonaContext, RunJob } from "./runtime.js";
import type { SessionCronRecord, SessionRecord } from "./session.js";

export interface WorkerPayload {
	agent: AgentSpec;
	job: RunJob;
	currentSession: SessionRecord;
	capabilities: ChannelCapabilities;
	runtimeDirectory: RuntimeDirectorySnapshot;
	personaContext?: PreparedPersonaContext;
	scheduledReminder?: RunJob["scheduledReminder"];
	serverTimezone: string;
	sessionCrons: SessionCronRecord[];
	selfIdentity?: {
		telegramHandles?: string[];
		platformUserId?: string;
		isExplicitlyAddressed?: boolean;
	};
	effectiveModel?: {
		provider: string;
		modelId: string;
		thinkingLevel?: ThinkingLevel;
	};
}

export interface WorkerResult {
	outbound: ReplyPayload;
	toolActions?: ChannelToolAction[];
	stopReason?: string;
	errorMessage?: string;
}
