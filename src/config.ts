import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const NEKOCLAW_NAME = "nekoclaw";

export const NEKOCLAW_ROOT_DIR = join(homedir(), `.${NEKOCLAW_NAME}`);
export const NEKOCLAW_CONFIG_PATH = join(NEKOCLAW_ROOT_DIR, "nekoclaw.json");
export const NEKOCLAW_RUNTIME_DIR = join(NEKOCLAW_ROOT_DIR, "runtime");
export const NEKOCLAW_WORKSPACES_DIR = join(NEKOCLAW_ROOT_DIR, "workspaces");

// Legacy config layout kept only for one-time import.
export const NEKOCLAW_LEGACY_AGENTS_DIR = join(NEKOCLAW_ROOT_DIR, "agents");
export const NEKOCLAW_LEGACY_CHANNELS_DIR = join(NEKOCLAW_ROOT_DIR, "channels");
export const NEKOCLAW_LEGACY_CHATS_DIR = join(NEKOCLAW_ROOT_DIR, "chats");
export const NEKOCLAW_LEGACY_SECRETS_DIR = join(NEKOCLAW_ROOT_DIR, "secrets");

export const NEKOCLAW_RUNTIME_STATES_DIR = join(NEKOCLAW_RUNTIME_DIR, "agents");
export const NEKOCLAW_RUNTIME_QUEUES_DIR = join(NEKOCLAW_RUNTIME_DIR, "queues");
export const NEKOCLAW_RUNTIME_AUDIT_DIR = join(NEKOCLAW_RUNTIME_DIR, "audit");
export const NEKOCLAW_RUNTIME_PAIRS_DIR = join(NEKOCLAW_RUNTIME_DIR, "pairs");
export const NEKOCLAW_RUNTIME_CONTROL_DIR = join(NEKOCLAW_RUNTIME_DIR, "control");
export const NEKOCLAW_RUNTIME_CRONS_DIR = join(NEKOCLAW_RUNTIME_DIR, "crons");
export const NEKOCLAW_RUNTIME_PROCESS_STATE_PATH = join(NEKOCLAW_RUNTIME_DIR, "process.json");

export const NEKOCLAW_CONTAINER_WORKSPACE_DIR = "/workspace";
export const NEKOCLAW_CONTAINER_CODE_DIR = "/opt/nekoclaw-src";
export const NEKOCLAW_CUSTOM_MODEL_API_KEY_ENV = "NEKOCLAW_CUSTOM_MODEL_API_KEY";

export function ensureNekoclawLayout(): void {
	const dirs = [
		NEKOCLAW_ROOT_DIR,
		NEKOCLAW_RUNTIME_DIR,
		NEKOCLAW_RUNTIME_STATES_DIR,
		NEKOCLAW_RUNTIME_QUEUES_DIR,
		NEKOCLAW_RUNTIME_AUDIT_DIR,
		NEKOCLAW_RUNTIME_PAIRS_DIR,
		NEKOCLAW_RUNTIME_CONTROL_DIR,
		NEKOCLAW_RUNTIME_CRONS_DIR,
		NEKOCLAW_WORKSPACES_DIR,
	];
	for (const dir of dirs) {
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
	}
}
