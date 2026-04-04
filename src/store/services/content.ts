import type { AgentSpec } from "../../types/agent.js";
import type { ModelApiFormat } from "../../types/common.js";
import { AgentStore } from "../agent-store.js";
import { AuditStore } from "../audit-store.js";
import { ModelStore } from "../model-store.js";

export class ContentService {
	constructor(
		private readonly agents: AgentStore,
		private readonly models: ModelStore,
		private readonly audits: AuditStore,
	) {}

	readSoul(agentRef: string): string {
		return this.agents.readSoul(agentRef);
	}

	readAgents(agentRef: string): string {
		return this.agents.readAgents(agentRef);
	}

	writeSoul(agentRef: string, content: string): void {
		const agent = this.agents.getAgentByRef(agentRef);
		this.agents.writeSoul(agentRef, content);
		this.audits.audit(agent.agentId, "soul.updated", {});
	}

	readMemory(agentRef: string): string {
		return this.agents.readMemory(agentRef);
	}

	writeMemory(agentRef: string, content: string): void {
		const agent = this.agents.getAgentByRef(agentRef);
		this.agents.writeMemory(agentRef, content);
		this.audits.audit(agent.agentId, "memory.updated", {});
	}

	readRuntimeModelsConfig(agentRef: string): Record<string, unknown> | undefined {
		return this.models.readRuntimeModelsConfig(agentRef);
	}

	writeRuntimeModelsConfig(agentRef: string, config: Record<string, unknown>, details: Record<string, unknown>): void {
		const agent = this.agents.getAgentByRef(agentRef);
		this.models.writeRuntimeModelsConfig(agentRef, config);
		this.audits.audit(agent.agentId, "model.runtime_updated", details);
	}

	getModelConfig(agentRef: string) {
		return this.models.getModelConfig(agentRef);
	}

	setBuiltinModelConfig(
		agentRef: string,
		input: { provider: string; modelId: string; apiKey?: string; thinkingLevel?: AgentSpec["thinkingLevel"] },
	) {
		const agent = this.models.setBuiltinModelConfig(agentRef, input);
		this.audits.audit(agent.agentId, "model.updated", { provider: input.provider, modelId: input.modelId, kind: "builtin" });
		return agent;
	}

	setCustomModelConfig(
		agentRef: string,
		input: {
			baseUrl: string;
			api: ModelApiFormat;
			providerId: string;
			modelId: string;
			apiKey?: string;
			thinkingLevel?: AgentSpec["thinkingLevel"];
		},
	) {
		const agent = this.models.setCustomModelConfig(agentRef, input);
		this.audits.audit(agent.agentId, "model.updated", {
			baseUrl: input.baseUrl,
			api: input.api,
			providerId: input.providerId,
			modelId: input.modelId,
			kind: "custom",
		});
		return agent;
	}
}
