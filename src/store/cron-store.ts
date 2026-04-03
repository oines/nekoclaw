import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import type { SessionCronRecord } from "../types.js";
import { readJsonFile, writeJsonFile } from "./fs.js";
import { getServerTimezone, normalizeTimezone, validateDailyTimePart, validateRunAtLocal, computeCronNextRunAt } from "./cron-schedule.js";
import { nowIso, readDirectoryJson } from "./helpers.js";
import { StorePaths } from "./paths.js";

export class CronStore {
	constructor(private readonly paths: StorePaths) {}

	listCrons(agentId?: string): SessionCronRecord[] {
		return readDirectoryJson<SessionCronRecord>(this.paths.getCronsDir())
			.filter((cron) => (agentId ? cron.agentId === agentId : true))
			.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}

	listActiveSessionCrons(agentId: string, sessionRecordId: string): SessionCronRecord[] {
		return this.listCrons(agentId)
			.filter((cron) => cron.sessionRecordId === sessionRecordId && cron.status === "active")
			.sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt));
	}

	createSessionCron(input: {
		cronId?: string;
		agentId: string;
		sessionRecordId: string;
		sessionKey: string;
		channelType: SessionCronRecord["channelType"];
		chatKind: SessionCronRecord["chatKind"];
		externalConversationId: string;
		threadId?: string;
		chatTitle?: string;
		createdFromResetGeneration: number;
		scheduleKind: SessionCronRecord["scheduleKind"];
		message: string;
		timezone?: string;
		runAtLocal?: string;
		hour?: number;
		minute?: number;
	}): SessionCronRecord {
		const createdAt = nowIso();
		const timezone = normalizeTimezone(input.timezone);
		const message = input.message.trim();
		if (!message) {
			throw new Error("cron message is required");
		}
		const scheduleKind = input.scheduleKind;
		const runAtLocal = scheduleKind === "once" ? validateRunAtLocal(input.runAtLocal ?? "") : undefined;
		const hour = scheduleKind === "daily" ? validateDailyTimePart("hour", input.hour ?? Number.NaN, 23) : undefined;
		const minute = scheduleKind === "daily" ? validateDailyTimePart("minute", input.minute ?? Number.NaN, 59) : undefined;
		const nextRunAt = computeCronNextRunAt({
			scheduleKind,
			timezone,
			runAtLocal,
			hour,
			minute,
		});
		const cron: SessionCronRecord = {
			cronId: input.cronId?.trim() || randomUUID(),
			agentId: input.agentId,
			sessionRecordId: input.sessionRecordId,
			sessionKey: input.sessionKey,
			channelType: input.channelType,
			chatKind: input.chatKind,
			externalConversationId: input.externalConversationId,
			threadId: input.threadId,
			chatTitle: input.chatTitle,
			status: "active",
			scheduleKind,
			message,
			timezone,
			runAtLocal,
			hour,
			minute,
			nextRunAt,
			createdAt,
			updatedAt: createdAt,
			createdFromResetGeneration: input.createdFromResetGeneration,
		};
		this.writeCron(cron);
		return cron;
	}

	cancelSessionCron(agentId: string, sessionRecordId: string, cronId: string): SessionCronRecord {
		const cron = this.requireCron(cronId);
		if (cron.agentId !== agentId || cron.sessionRecordId !== sessionRecordId) {
			throw new Error(`Unknown cron "${cronId}" for this session`);
		}
		if (cron.status !== "active") {
			return cron;
		}
		const updated: SessionCronRecord = {
			...cron,
			status: "canceled",
			updatedAt: nowIso(),
		};
		this.writeCron(updated);
		return updated;
	}

	invalidateSessionCrons(agentId: string, sessionRecordId: string): SessionCronRecord[] {
		const updatedAt = nowIso();
		const updated: SessionCronRecord[] = [];
		for (const cron of this.listActiveSessionCrons(agentId, sessionRecordId)) {
			const next: SessionCronRecord = {
				...cron,
				status: "invalidated",
				updatedAt,
			};
			this.writeCron(next);
			updated.push(next);
		}
		return updated;
	}

	listDueCrons(at: Date = new Date()): SessionCronRecord[] {
		const now = at.getTime();
		return this.listCrons()
			.filter((cron) => cron.status === "active" && Date.parse(cron.nextRunAt) <= now)
			.sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt));
	}

	completeCron(cronId: string, triggeredAt: string): SessionCronRecord {
		const cron = this.requireCron(cronId);
		const updated: SessionCronRecord = {
			...cron,
			status: "completed",
			lastTriggeredAt: triggeredAt,
			updatedAt: triggeredAt,
		};
		this.writeCron(updated);
		return updated;
	}

	advanceDailyCron(cronId: string, triggeredAt: string): SessionCronRecord {
		const cron = this.requireCron(cronId);
		if (cron.scheduleKind !== "daily") {
			throw new Error(`Cron "${cronId}" is not daily`);
		}
		const nextRunAt = computeCronNextRunAt({
			scheduleKind: "daily",
			timezone: cron.timezone,
			hour: cron.hour,
			minute: cron.minute,
			from: new Date(Date.parse(triggeredAt) + 1_000),
		});
		const updated: SessionCronRecord = {
			...cron,
			nextRunAt,
			lastTriggeredAt: triggeredAt,
			updatedAt: triggeredAt,
		};
		this.writeCron(updated);
		return updated;
	}

	invalidateCron(cronId: string): SessionCronRecord {
		const cron = this.requireCron(cronId);
		if (cron.status !== "active") {
			return cron;
		}
		const updated: SessionCronRecord = {
			...cron,
			status: "invalidated",
			updatedAt: nowIso(),
		};
		this.writeCron(updated);
		return updated;
	}

	getCron(cronId: string): SessionCronRecord | undefined {
		const path = this.paths.getCronPath(cronId);
		if (!existsSync(path)) {
			return undefined;
		}
		return readJsonFile<SessionCronRecord | undefined>(path, undefined);
	}

	deleteCronsForAgent(agentId: string): void {
		for (const cron of this.listCrons(agentId)) {
			rmSync(this.paths.getCronPath(cron.cronId), { force: true });
		}
	}

	getDefaultTimezone(): string {
		return getServerTimezone();
	}

	private requireCron(cronId: string): SessionCronRecord {
		const cron = this.getCron(cronId);
		if (!cron) {
			throw new Error(`Unknown cron "${cronId}"`);
		}
		return cron;
	}

	private writeCron(cron: SessionCronRecord): void {
		writeJsonFile(this.paths.getCronPath(cron.cronId), cron);
	}
}
