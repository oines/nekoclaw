import type { ChannelType, ChatKind } from "../../types/common.js";
import { AgentStore } from "../agent-store.js";
import { AuditStore } from "../audit-store.js";
import { PairStore } from "../pair-store.js";
import { SessionStore } from "../session-store.js";
import { SessionLifecycleService } from "./session-lifecycle.js";

export class PairingService {
	constructor(
		private readonly agents: AgentStore,
		private readonly sessions: SessionStore,
		private readonly sessionLifecycle: SessionLifecycleService,
		private readonly pairs: PairStore,
		private readonly audits: AuditStore,
	) {}

	listPairRequests(agentId?: string) {
		return this.pairs.listPairRequests(agentId);
	}

	createOrReusePair(
		agentRef: string,
		input: {
			channelType: ChannelType;
			externalConversationId: string;
			chatKind: ChatKind;
			threadId?: string;
			parentSessionKey?: string;
			sessionKey?: string;
			senderId?: string;
			senderName?: string;
			chatTitle?: string;
			ttlMinutes?: number;
		},
	) {
		const agent = this.agents.getAgentByRef(agentRef);
		const pair = this.pairs.createOrReusePair(agent.agentId, {
			...input,
			sessionKey:
				input.sessionKey ||
				this.sessions.resolveSessionKey(agent.agentId, {
					channelType: input.channelType,
					externalConversationId: input.externalConversationId,
					chatKind: input.chatKind,
					threadId: input.threadId,
					parentSessionKey: input.parentSessionKey,
				}),
		});
		this.audits.audit(agent.agentId, "pair.created", {
			code: pair.code,
			sessionKey: pair.sessionKey,
			channelType: pair.channelType,
			chatKind: pair.chatKind,
		});
		return pair;
	}

	touchPairPrompt(pairingId: string) {
		return this.pairs.touchPairPrompt(pairingId);
	}

	getPairByCode(code: string) {
		return this.pairs.getPairByCode(code);
	}

	acceptPair(code: string) {
		const pair = this.pairs.getPairByCode(code);
		const session = this.sessionLifecycle.createSession(pair.agentId, {
			channelType: pair.channelType,
			externalConversationId: pair.externalConversationId,
			chatKind: pair.chatKind,
			chatTitle: pair.chatTitle,
			threadId: pair.threadId,
			parentSessionKey: pair.parentSessionKey,
			sessionKey: pair.sessionKey,
		});
		const updated = this.pairs.markAccepted(code);
		this.audits.audit(pair.agentId, "pair.accepted", {
			code,
			sessionRecordId: session.sessionRecordId,
			sessionKey: session.sessionKey,
		});
		return { pair: updated, session };
	}

	rejectPair(code: string) {
		const pair = this.pairs.markRejected(code);
		this.audits.audit(pair.agentId, "pair.rejected", { code });
		return pair;
	}

	deletePairRequestsForAgent(agentId: string): void {
		this.pairs.deletePairsForAgent(agentId);
	}
}
