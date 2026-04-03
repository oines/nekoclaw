import type { ChannelType } from "../../types/common.js";
import { AgentStore } from "../agent-store.js";
import { AuditStore } from "../audit-store.js";
import { ChannelStore } from "../channel-store.js";
import { SessionStore } from "../session-store.js";
import { SessionLifecycleService } from "./session-lifecycle.js";

export class ChannelLifecycleService {
	constructor(
		private readonly agents: AgentStore,
		private readonly channels: ChannelStore,
		private readonly sessions: SessionStore,
		private readonly sessionLifecycle: SessionLifecycleService,
		private readonly audits: AuditStore,
	) {}

	createChannel(agentRef: string, type: ChannelType) {
		const channel = this.channels.createChannel(agentRef, type);
		this.audits.audit(channel.agentId, "channel.created", { type });
		return channel;
	}

	removeChannel(agentRef: string, type: ChannelType, options?: { force?: boolean }) {
		const agent = this.agents.getAgentByRef(agentRef);
		const channel = this.channels.getChannel(agent.agentId, type);
		const sessions = this.sessions.listSessions(agent.agentId).filter((session) => session.channelType === type);
		if (!options?.force && sessions.length > 0) {
			throw new Error(`The ${type} channel still has paired sessions. Remove them first or use --force.`);
		}
		for (const session of sessions) {
			this.sessionLifecycle.removeSession(agent.agentId, session.sessionRecordId, { purge: true });
		}
		const removed = this.channels.removeChannel(agentRef, type);
		this.audits.audit(agent.agentId, "channel.removed", { type });
		return removed ?? channel;
	}

	setChannelToken(agentRef: string, type: ChannelType, token: string): void {
		this.channels.setChannelToken(agentRef, type, token);
		const agent = this.agents.getAgentByRef(agentRef);
		this.audits.audit(agent.agentId, "channel.token_saved", { type });
	}

	setNapcatEndpoint(agentRef: string, input: { wsUrl: string; selfId?: string }): void {
		this.channels.setNapcatEndpoint(agentRef, input);
		const agent = this.agents.getAgentByRef(agentRef);
		this.audits.audit(agent.agentId, "channel.endpoint_saved", {
			type: "napcat",
			wsUrl: input.wsUrl,
			selfId: input.selfId,
		});
	}

	setChannelGroupTrigger(agentRef: string, type: ChannelType, groupTrigger: "all" | "mention"): void {
		this.channels.setGroupTrigger(agentRef, type, groupTrigger);
		const agent = this.agents.getAgentByRef(agentRef);
		this.audits.audit(agent.agentId, "channel.group_trigger_saved", {
			type,
			groupTrigger,
		});
	}
}
