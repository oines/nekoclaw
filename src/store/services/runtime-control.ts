import { NEKOCLAW_RUNTIME_CONTROL_DIR } from "../../config.js";
import type { QueueEvent, RunJob, RuntimeControlAction, RuntimeProcessState, RuntimeState } from "../../types/runtime.js";
import { RuntimeStateStore } from "../runtime-state-store.js";

export class RuntimeControlStoreService {
	constructor(private readonly runtime: RuntimeStateStore) {}

	getRuntimeState(agentId: string): RuntimeState {
		return this.runtime.getRuntimeState(agentId);
	}

	writeRuntimeState(state: RuntimeState): void {
		this.runtime.writeRuntimeState(state);
	}

	getRuntimeProcessState(): RuntimeProcessState {
		return this.runtime.getRuntimeProcessState();
	}

	writeRuntimeProcessState(state: RuntimeProcessState, options?: { skipLock?: boolean }): void {
		this.runtime.writeRuntimeProcessState(state, options);
	}

	createRuntimeControlAction(
		action: Omit<RuntimeControlAction, "requestId" | "status" | "requestedAt" | "updatedAt">,
	): RuntimeControlAction {
		return this.runtime.createRuntimeControlAction(action);
	}

	getRuntimeControlAction(requestId: string): RuntimeControlAction | undefined {
		return this.runtime.getRuntimeControlAction(requestId);
	}

	listPendingRuntimeControlActions(): RuntimeControlAction[] {
		return this.runtime.listPendingRuntimeControlActions(NEKOCLAW_RUNTIME_CONTROL_DIR);
	}

	writeRuntimeControlAction(action: RuntimeControlAction): void {
		this.runtime.writeRuntimeControlAction(action);
	}

	deleteRuntimeControlAction(requestId: string): void {
		this.runtime.deleteRuntimeControlAction(requestId);
	}

	appendQueueEvent(agentId: string, event: QueueEvent): void {
		this.runtime.appendQueueEvent(agentId, event);
	}

	getQueueEvents(agentId: string): QueueEvent[] {
		return this.runtime.getQueueEvents(agentId);
	}

	rewriteQueueEvents(agentId: string, events: QueueEvent[]): void {
		this.runtime.rewriteQueueEvents(agentId, events);
	}

	recoverPendingJobs(agentId: string): RunJob[] {
		return this.runtime.recoverPendingJobs(agentId);
	}

	removeAgentArtifacts(agentId: string): void {
		this.runtime.removeAgentArtifacts(agentId);
	}
}
