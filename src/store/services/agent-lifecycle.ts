import { nowIso } from "../helpers.js";
import { AgentStore, type CreateAgentInput, type UpdateAgentInput } from "../agent-store.js";
import { AuditStore } from "../audit-store.js";
import { ChannelStore } from "../channel-store.js";
import { CronStore } from "../cron-store.js";
import { PairStore } from "../pair-store.js";
import { RuntimeStateStore } from "../runtime-state-store.js";
import { SessionStore } from "../session-store.js";
import { SessionLifecycleService } from "./session-lifecycle.js";

export class AgentLifecycleService {
	constructor(
		private readonly agents: AgentStore,
		private readonly channels: ChannelStore,
		private readonly sessions: SessionStore,
		private readonly sessionLifecycle: SessionLifecycleService,
		private readonly crons: CronStore,
		private readonly pairs: PairStore,
		private readonly runtime: RuntimeStateStore,
		private readonly audits: AuditStore,
	) {}

	createAgent(input: CreateAgentInput) {
		const agent = this.agents.createAgent(input);
		this.runtime.writeRuntimeState({
			agentId: agent.agentId,
			containerStatus: "missing",
			updatedAt: nowIso(),
		});
		this.audits.audit(agent.agentId, "agent.created", { slug: agent.slug });
		return agent;
	}

	updateAgent(ref: string, patch: UpdateAgentInput) {
		const agent = this.agents.updateAgent(ref, patch);
		this.audits.audit(agent.agentId, "agent.updated", patch as Record<string, unknown>);
		return agent;
	}

	deleteAgent(ref: string, options?: { force?: boolean }) {
		const agent = this.agents.getAgentByRef(ref);
		const activeChannels = this.channels.listChannels(agent.agentId);
		const activeSessions = this.sessions.listSessions(agent.agentId);
		if (!options?.force && (activeChannels.length > 0 || activeSessions.length > 0)) {
			throw new Error(`Agent "${agent.slug}" still has channels or sessions. Use --force to remove it.`);
		}
		for (const session of activeSessions) {
			this.sessionLifecycle.removeSession(agent.agentId, session.sessionRecordId, { purge: true });
		}
		this.crons.deleteCronsForAgent(agent.agentId);
		this.pairs.deletePairsForAgent(agent.agentId);
		this.runtime.removeAgentArtifacts(agent.agentId);
		this.agents.removeWorkspace(agent.slug);
		return this.agents.deleteAgentConfig(agent.agentId);
	}
}
