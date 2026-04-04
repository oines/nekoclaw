import { removeAgentContainer } from "./docker.js";
import { JsonNekoclawStore } from "../store/json-store.js";
import type { AgentSpec } from "../types.js";
import { nowIso } from "../store/helpers.js";

export class RuntimeControlService {
	constructor(
		private readonly store: JsonNekoclawStore,
		private readonly channelPlugins: Map<string, { stop(): void }>,
		private readonly agentQueues: Map<string, Map<string, unknown[]>>,
		private readonly activeRunsByAgent: Map<string, Map<string, unknown>>,
	) {}

	async removeAgentRuntime(agentRef: string | Pick<AgentSpec, "agentId" | "containerName">): Promise<void> {
		const agent = typeof agentRef === "string" ? this.store.getAgentByRef(agentRef) : agentRef;
		const keyPrefix = `${agent.agentId}:`;
		for (const [key, plugin] of this.channelPlugins.entries()) {
			if (!key.startsWith(keyPrefix)) {
				continue;
			}
			plugin.stop();
			this.channelPlugins.delete(key);
		}
		this.agentQueues.delete(agent.agentId);
		this.activeRunsByAgent.delete(agent.agentId);
		await removeAgentContainer(agent.containerName);
		this.store.writeRuntimeState({
			...this.store.getRuntimeState(agent.agentId),
			agentId: agent.agentId,
			containerStatus: "missing",
			currentJobId: undefined,
			activeRuns: [],
			updatedAt: nowIso(),
		});
	}

	async processRuntimeControlActions(): Promise<void> {
		for (const action of this.store.listPendingRuntimeControlActions()) {
			try {
				if (action.kind === "agent.remove_runtime") {
					await this.removeAgentRuntime(action.agent);
				}
				this.store.writeRuntimeControlAction({
					...action,
					status: "completed",
					updatedAt: nowIso(),
					error: undefined,
				});
			} catch (error) {
				this.store.writeRuntimeControlAction({
					...action,
					status: "failed",
					updatedAt: nowIso(),
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}
}
