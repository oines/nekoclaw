import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { NEKOCLAW_RUNTIME_CONTROL_DIR, NEKOCLAW_RUNTIME_PROCESS_STATE_PATH } from "../config.js";
import type { QueueEvent, RunJob, RuntimeControlAction, RuntimeProcessState, RuntimeState } from "../types.js";
import { appendJsonLine, readJsonFile, readJsonLines, writeJsonFile, writeTextFile } from "./fs.js";
import { nowIso, readDirectoryJson } from "./helpers.js";
import { StorePaths } from "./paths.js";

export class RuntimeStateStore {
	constructor(private readonly paths: StorePaths) {}

	getRuntimeState(agentId: string): RuntimeState {
		return readJsonFile<RuntimeState>(this.paths.getRuntimeStatePath(agentId), {
			agentId,
			containerStatus: "missing",
			activeRuns: [],
			updatedAt: nowIso(),
		});
	}

	writeRuntimeState(state: RuntimeState): void {
		writeJsonFile(this.paths.getRuntimeStatePath(state.agentId), state);
	}

	getRuntimeProcessState(): RuntimeProcessState {
		return readJsonFile<RuntimeProcessState>(NEKOCLAW_RUNTIME_PROCESS_STATE_PATH, {
			updatedAt: nowIso(),
		});
	}

	writeRuntimeProcessState(state: RuntimeProcessState, options?: { skipLock?: boolean }): void {
		writeJsonFile(NEKOCLAW_RUNTIME_PROCESS_STATE_PATH, state, { skipLock: options?.skipLock });
	}

	createRuntimeControlAction(
		action: Omit<RuntimeControlAction, "requestId" | "status" | "requestedAt" | "updatedAt">,
	): RuntimeControlAction {
		const timestamp = nowIso();
		const request: RuntimeControlAction = {
			requestId: randomUUID(),
			status: "pending",
			requestedAt: timestamp,
			updatedAt: timestamp,
			...action,
		};
		writeJsonFile(this.paths.getRuntimeControlPath(request.requestId), request);
		return request;
	}

	getRuntimeControlAction(requestId: string): RuntimeControlAction | undefined {
		const path = this.paths.getRuntimeControlPath(requestId);
		if (!existsSync(path)) {
			return undefined;
		}
		return readJsonFile<RuntimeControlAction>(path, {} as RuntimeControlAction);
	}

	listPendingRuntimeControlActions(controlDir: string): RuntimeControlAction[] {
		return readDirectoryJson<RuntimeControlAction>(controlDir)
			.filter((action) => action.status === "pending")
			.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
	}

	writeRuntimeControlAction(action: RuntimeControlAction): void {
		writeJsonFile(this.paths.getRuntimeControlPath(action.requestId), action);
	}

	deleteRuntimeControlAction(requestId: string): void {
		rmSync(this.paths.getRuntimeControlPath(requestId), { force: true });
	}

	appendQueueEvent(agentId: string, event: QueueEvent): void {
		appendJsonLine(this.paths.getQueuePath(agentId), event);
	}

	getQueueEvents(agentId: string): QueueEvent[] {
		return readJsonLines<QueueEvent>(this.paths.getQueuePath(agentId));
	}

	rewriteQueueEvents(agentId: string, events: QueueEvent[]): void {
		const text = events.map((event) => JSON.stringify(event)).join("\n");
		writeTextFile(this.paths.getQueuePath(agentId), text.length > 0 ? `${text}\n` : "");
	}

	recoverPendingJobs(agentId: string): RunJob[] {
		const pending = new Map<string, RunJob>();
		for (const event of this.getQueueEvents(agentId)) {
			if (event.type === "enqueue" && event.job) {
				pending.set(event.jobId, event.job);
				continue;
			}
			if (event.type === "complete" || event.type === "fail" || event.type === "cancel") {
				pending.delete(event.jobId);
			}
		}
		return Array.from(pending.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}

	removeAgentArtifacts(agentId: string): void {
		for (const path of [this.paths.getRuntimeStatePath(agentId), this.paths.getQueuePath(agentId), this.paths.getAuditPath(agentId)]) {
			if (existsSync(path)) {
				rmSync(path, { recursive: true, force: true });
			}
		}
	}
}
