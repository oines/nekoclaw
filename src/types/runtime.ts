import type { AgentSpec } from "./agent.js";
import type { InboundMessageEvent } from "./message.js";

export interface RuntimeState {
	agentId: string;
	containerStatus?: string;
	currentJobId?: string;
	lastError?: string;
	updatedAt: string;
}

export interface RuntimeProcessState {
	pid?: number;
	updatedAt: string;
}

export interface RuntimeControlAction {
	requestId: string;
	kind: "agent.remove_runtime";
	status: "pending" | "completed" | "failed";
	agent: Pick<AgentSpec, "agentId" | "slug" | "containerName">;
	requestedAt: string;
	updatedAt: string;
	error?: string;
}

export interface RunJob {
	jobId: string;
	agentId: string;
	kind: "inbound" | "scheduled";
	sessionRecordId: string;
	sessionKey: string;
	createdAt: string;
	event: InboundMessageEvent;
	scheduledReminder?: {
		cronId: string;
		message: string;
		timezone: string;
		scheduledFor: string;
	};
}

export interface QueueEvent {
	type: "enqueue" | "start" | "complete" | "fail";
	jobId: string;
	timestamp: string;
	job?: RunJob;
	error?: string;
}

export interface PreparedPersonaContext {
	indexMarkdown: string;
	selectedMemoryMarkdowns: PreparedPersonaMemoryEntry[];
	sceneObservations: string;
}

export interface PreparedPersonaMemoryEntry {
	path: string;
	kind: "people" | "scene";
	title: string;
	description: string;
	markdown: string;
}

export interface RuntimeDirectoryContactSnapshot {
	account: string;
	displayName?: string;
	channel: "telegram" | "qq";
	lastSeenAt: string;
	pairedSessionKey?: string;
	sourceHints: string[];
}

export interface RuntimeDirectoryGroupSnapshot {
	groupRef: string;
	title?: string;
	channel: "telegram" | "qq";
	lastSeenAt: string;
	pairedSessionKey?: string;
}

export interface RuntimeDirectoryGroupMemberSnapshot {
	account: string;
	displayName?: string;
	lastSeenAt: string;
	source: "runtime_seen" | "napcat_live";
}

export interface RuntimeDirectorySnapshot {
	contacts: RuntimeDirectoryContactSnapshot[];
	groups: RuntimeDirectoryGroupSnapshot[];
	groupMembers: Record<string, RuntimeDirectoryGroupMemberSnapshot[]>;
	availableChannels: Array<"telegram" | "qq">;
}

export interface AuditEntry {
	timestamp: string;
	kind: string;
	agentId: string;
	details: Record<string, unknown>;
}
