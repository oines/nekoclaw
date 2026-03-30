import { join } from "node:path";
import {
	NEKOCLAW_RUNTIME_AUDIT_DIR,
	NEKOCLAW_RUNTIME_CONTROL_DIR,
	NEKOCLAW_RUNTIME_PAIRS_DIR,
	NEKOCLAW_RUNTIME_QUEUES_DIR,
	NEKOCLAW_RUNTIME_STATES_DIR,
	NEKOCLAW_WORKSPACES_DIR,
} from "../config.js";

export class StorePaths {
	getWorkspaceRoot(slug: string): string {
		return join(NEKOCLAW_WORKSPACES_DIR, slug);
	}

	getSoulPath(slug: string): string {
		return join(this.getWorkspaceRoot(slug), "SOUL.md");
	}

	getAgentsPath(slug: string): string {
		return join(this.getWorkspaceRoot(slug), "AGENTS.md");
	}

	getMemoryPath(slug: string): string {
		return join(this.getWorkspaceRoot(slug), "MEMORY.md");
	}

	getSkillsDir(slug: string): string {
		return join(this.getWorkspaceRoot(slug), "skills");
	}

	getRuntimeAgentDir(slug: string): string {
		return join(this.getWorkspaceRoot(slug), ".nekoclaw-runtime");
	}

	getRuntimeModelsPath(slug: string): string {
		return join(this.getRuntimeAgentDir(slug), "models.json");
	}

	getSessionDir(slug: string, sessionRecordId: string): string {
		return join(this.getWorkspaceRoot(slug), "chats", sessionRecordId);
	}

	getSessionLogPath(slug: string, sessionRecordId: string): string {
		return join(this.getSessionDir(slug, sessionRecordId), "log.jsonl");
	}

	getSessionContextPath(slug: string, sessionRecordId: string): string {
		return join(this.getSessionDir(slug, sessionRecordId), "context.jsonl");
	}

	getSessionAttachmentsDir(slug: string, sessionRecordId: string): string {
		return join(this.getSessionDir(slug, sessionRecordId), "attachments");
	}

	getRuntimeStatePath(agentId: string): string {
		return join(NEKOCLAW_RUNTIME_STATES_DIR, `${agentId}.json`);
	}

	getQueuePath(agentId: string): string {
		return join(NEKOCLAW_RUNTIME_QUEUES_DIR, `${agentId}.jsonl`);
	}

	getAuditPath(agentId: string): string {
		return join(NEKOCLAW_RUNTIME_AUDIT_DIR, `${agentId}.jsonl`);
	}

	getPairPath(pairingId: string): string {
		return join(NEKOCLAW_RUNTIME_PAIRS_DIR, `${pairingId}.json`);
	}

	getRuntimeControlPath(requestId: string): string {
		return join(NEKOCLAW_RUNTIME_CONTROL_DIR, `${requestId}.json`);
	}

	getLegacyRuntimeModelsPath(slug: string): string {
		return join(NEKOCLAW_WORKSPACES_DIR, slug, ".nekoclaw-runtime", "models.json");
	}
}
