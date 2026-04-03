import type { ChannelType, ChatKind } from "../../types/common.js";
import type { SessionRecord } from "../../types/session.js";
import { AuditStore } from "../audit-store.js";
import { CronStore } from "../cron-store.js";
import { SessionStore } from "../session-store.js";

export class SessionLifecycleService {
	constructor(
		private readonly sessions: SessionStore,
		private readonly crons: CronStore,
		private readonly audits: AuditStore,
	) {}

	createSession(
		agentRef: string,
		input: {
			channelType: ChannelType;
			externalConversationId: string;
			chatKind: ChatKind;
			chatTitle?: string;
			threadId?: string;
			parentSessionKey?: string;
			sessionKey?: string;
		},
	): SessionRecord {
		const session = this.sessions.createSession(agentRef, input);
		this.audits.audit(session.agentId, "session.created", {
			sessionRecordId: session.sessionRecordId,
			sessionKey: session.sessionKey,
			channelType: session.channelType,
			chatKind: session.chatKind,
		});
		return session;
	}

	updateSessionLastRoute(
		agentRef: string,
		sessionRef: string,
		input: { externalConversationId: string; threadId?: string },
	): SessionRecord {
		return this.sessions.updateSessionLastRoute(agentRef, sessionRef, input);
	}

	updateSessionChatTitle(agentRef: string, sessionRef: string, chatTitle: string): SessionRecord {
		const session = this.sessions.updateSessionChatTitle(agentRef, sessionRef, chatTitle);
		this.audits.audit(session.agentId, "session.chat_title_updated", {
			sessionRecordId: session.sessionRecordId,
			sessionKey: session.sessionKey,
			chatTitle: session.chatTitle,
		});
		return session;
	}

	setSessionModelOverride(
		agentRef: string,
		sessionRef: string,
		input: { provider: string; modelId: string },
	): SessionRecord {
		const session = this.sessions.setSessionModelOverride(agentRef, sessionRef, input);
		this.audits.audit(session.agentId, "session.model_override_set", {
			sessionRecordId: session.sessionRecordId,
			sessionKey: session.sessionKey,
			provider: input.provider,
			modelId: input.modelId,
		});
		return session;
	}

	clearSessionModelOverride(agentRef: string, sessionRef: string): SessionRecord {
		const session = this.sessions.clearSessionModelOverride(agentRef, sessionRef);
		this.audits.audit(session.agentId, "session.model_override_cleared", {
			sessionRecordId: session.sessionRecordId,
			sessionKey: session.sessionKey,
		});
		return session;
	}

	resetSession(agentRef: string, sessionRef: string): SessionRecord {
		const session = this.sessions.resetSession(agentRef, sessionRef);
		const invalidated = this.crons.invalidateSessionCrons(session.agentId, session.sessionRecordId);
		this.audits.audit(session.agentId, "session.reset", {
			sessionRecordId: session.sessionRecordId,
			sessionKey: session.sessionKey,
			resetGeneration: session.resetGeneration,
			invalidatedCronCount: invalidated.length,
		});
		return session;
	}

	removeSession(agentRef: string, ref: string, options?: { purge?: boolean }): SessionRecord {
		const session = this.sessions.removeSession(agentRef, ref, options);
		this.crons.invalidateSessionCrons(session.agentId, session.sessionRecordId);
		this.audits.audit(session.agentId, "session.removed", {
			sessionRecordId: session.sessionRecordId,
			sessionKey: session.sessionKey,
			purge: Boolean(options?.purge),
		});
		return session;
	}

	appendSessionLog(agentRef: string, sessionRecordId: string, value: unknown): void {
		this.sessions.appendSessionLog(agentRef, sessionRecordId, value);
	}
}
