import type { SessionCronRecord } from "../../types/session.js";
import { AuditStore } from "../audit-store.js";
import { CronStore } from "../cron-store.js";
import { SessionStore } from "../session-store.js";

export class CronLifecycleService {
	constructor(
		private readonly sessions: SessionStore,
		private readonly crons: CronStore,
		private readonly audits: AuditStore,
	) {}

	createSessionCron(
		agentRef: string,
		sessionRef: string,
		input: {
			cronId?: string;
			scheduleKind: SessionCronRecord["scheduleKind"];
			message: string;
			timezone?: string;
			runAtLocal?: string;
			hour?: number;
			minute?: number;
		},
	): SessionCronRecord {
		const session = this.sessions.getSession(agentRef, sessionRef);
		const cron = this.crons.createSessionCron({
			...input,
			agentId: session.agentId,
			sessionRecordId: session.sessionRecordId,
			sessionKey: session.sessionKey,
			channelType: session.channelType,
			chatKind: session.chatKind,
			externalConversationId: session.externalConversationId,
			threadId: session.threadId,
			chatTitle: session.chatTitle,
			createdFromResetGeneration: session.resetGeneration,
		});
		this.audits.audit(session.agentId, "cron.created", {
			cronId: cron.cronId,
			sessionRecordId: session.sessionRecordId,
			scheduleKind: cron.scheduleKind,
			nextRunAt: cron.nextRunAt,
		});
		return cron;
	}

	cancelSessionCron(agentRef: string, sessionRef: string, cronId: string): SessionCronRecord {
		const session = this.sessions.getSession(agentRef, sessionRef);
		const cron = this.crons.cancelSessionCron(session.agentId, session.sessionRecordId, cronId);
		this.audits.audit(session.agentId, "cron.canceled", {
			cronId: cron.cronId,
			sessionRecordId: session.sessionRecordId,
		});
		return cron;
	}

	completeCron(cronId: string, triggeredAt: string): SessionCronRecord {
		const cron = this.crons.completeCron(cronId, triggeredAt);
		this.audits.audit(cron.agentId, "cron.completed", {
			cronId: cron.cronId,
			sessionRecordId: cron.sessionRecordId,
			triggeredAt,
		});
		return cron;
	}

	advanceDailyCron(cronId: string, triggeredAt: string): SessionCronRecord {
		const cron = this.crons.advanceDailyCron(cronId, triggeredAt);
		this.audits.audit(cron.agentId, "cron.advanced", {
			cronId: cron.cronId,
			sessionRecordId: cron.sessionRecordId,
			triggeredAt,
			nextRunAt: cron.nextRunAt,
		});
		return cron;
	}

	invalidateCron(cronId: string, reason?: string): SessionCronRecord {
		const cron = this.crons.invalidateCron(cronId);
		this.audits.audit(cron.agentId, "cron.invalidated", {
			cronId: cron.cronId,
			sessionRecordId: cron.sessionRecordId,
			reason,
		});
		return cron;
	}
}
