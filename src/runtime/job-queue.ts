import { JsonNekoclawStore } from "../store/json-store.js";
import type { ActiveRunState, QueueEvent, QueueStatus, RunJob, WorkerResult } from "../types.js";
import { nowIso } from "../store/helpers.js";
import { QueueFullError } from "./errors.js";

function toQueueEvent(type: QueueEvent["type"], job: RunJob, error?: string): QueueEvent {
	return {
		type,
		jobId: job.jobId,
		timestamp: nowIso(),
		job: type === "enqueue" ? job : undefined,
		error,
	};
}

const MAX_QUEUE_DEPTH = 50;
export const MAX_CONCURRENT_SESSIONS_PER_AGENT = 2;

type SessionQueueMap = Map<string, RunJob[]>;
type ActiveRunMap = Map<string, ActiveRunState>;

export class JobQueueService {
	constructor(
		private readonly store: JsonNekoclawStore,
		private readonly agentQueues: Map<string, SessionQueueMap>,
		private readonly activeRunsByAgent: Map<string, ActiveRunMap>,
		private readonly runJob: (job: RunJob) => Promise<WorkerResult>,
	) {}

	initialize(): void {
		for (const agent of this.store.listAgents()) {
			const jobs = this.store.recoverPendingJobs(agent.agentId);
			const sessionQueues = this.getOrCreateSessionQueues(agent.agentId);
			sessionQueues.clear();
			for (const job of jobs) {
				const queue = sessionQueues.get(job.sessionRecordId) ?? [];
				queue.push(job);
				sessionQueues.set(job.sessionRecordId, queue);
			}
			this.compactQueueLog(agent.agentId, sessionQueues);
		}
	}

	async enqueue(job: RunJob): Promise<void> {
		const sessionQueues = this.getOrCreateSessionQueues(job.agentId);
		if (this.getTrackedJobCount(sessionQueues) >= MAX_QUEUE_DEPTH) {
			this.store.audit(job.agentId, "queue.rejected", {
				jobId: job.jobId,
				sessionRecordId: job.sessionRecordId,
				sessionKey: job.sessionKey,
				reason: "queue_full",
				limit: MAX_QUEUE_DEPTH,
			});
			throw new QueueFullError(`Queue is full for agent ${job.agentId}`);
		}
		this.store.appendQueueEvent(job.agentId, toQueueEvent("enqueue", job));
		const queue = sessionQueues.get(job.sessionRecordId) ?? [];
		queue.push(job);
		sessionQueues.set(job.sessionRecordId, queue);
		this.store.audit(job.agentId, "queue.enqueue", {
			jobId: job.jobId,
			sessionRecordId: job.sessionRecordId,
			sessionKey: job.sessionKey,
		});
		void this.dispatchAgent(job.agentId);
	}

	clearAgent(agentId: string): void {
		this.agentQueues.delete(agentId);
		this.activeRunsByAgent.delete(agentId);
	}

	compactQueueLog(agentId: string, sessionQueues = this.agentQueues.get(agentId) ?? new Map<string, RunJob[]>()): void {
		const events: QueueEvent[] = [];
		for (const jobs of sessionQueues.values()) {
			for (const job of jobs) {
				events.push({
					type: "enqueue",
					jobId: job.jobId,
					timestamp: job.createdAt,
					job,
				});
			}
		}
		events.sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.jobId.localeCompare(right.jobId));
		this.store.rewriteQueueEvents(agentId, events);
	}

	compactIdleQueues(): void {
		for (const [agentId, sessionQueues] of this.agentQueues.entries()) {
			if (this.getTrackedJobCount(sessionQueues) === 0 && !this.hasActiveRuns(agentId)) {
				this.compactQueueLog(agentId, sessionQueues);
			}
		}
	}

	getStatus(agentId: string): QueueStatus {
		const sessionQueues = this.agentQueues.get(agentId);
		const activeRuns = Array.from(this.getActiveRuns(agentId).values()).sort(
			(left, right) => left.startedAt.localeCompare(right.startedAt) || left.jobId.localeCompare(right.jobId),
		);
		return {
			queued: this.getQueuedWaitingCount(sessionQueues, activeRuns),
			processing: activeRuns.length > 0,
			currentJobId: activeRuns[0]?.jobId,
			runningSessions: activeRuns.length,
			activeRuns,
			maxConcurrentSessions: MAX_CONCURRENT_SESSIONS_PER_AGENT,
		};
	}

	hasActiveRuns(agentId: string): boolean {
		return this.getActiveRuns(agentId).size > 0;
	}

	hasAnyActiveRuns(): boolean {
		for (const runs of this.activeRunsByAgent.values()) {
			if (runs.size > 0) {
				return true;
			}
		}
		return false;
	}

	private async dispatchAgent(agentId: string): Promise<void> {
		const sessionQueues = this.agentQueues.get(agentId);
		if (!sessionQueues || sessionQueues.size === 0) {
			return;
		}
		while (this.getActiveRuns(agentId).size < MAX_CONCURRENT_SESSIONS_PER_AGENT) {
			const nextSessionId = this.pickNextSession(agentId);
			if (!nextSessionId) {
				return;
			}
			this.store.audit(agentId, "queue.dispatch", {
				sessionRecordId: nextSessionId,
				activeRuns: this.getActiveRuns(agentId).size,
				maxConcurrentSessions: MAX_CONCURRENT_SESSIONS_PER_AGENT,
			});
			void this.processSession(agentId, nextSessionId);
		}
	}

	private async processSession(agentId: string, sessionRecordId: string): Promise<void> {
		const activeRuns = this.getActiveRuns(agentId);
		if (activeRuns.has(sessionRecordId)) {
			return;
		}
		const sessionQueues = this.agentQueues.get(agentId);
		const queue = sessionQueues?.get(sessionRecordId);
		if (!queue || queue.length === 0) {
			return;
		}
		while (queue.length > 0) {
			const job = queue[0];
			const runState: ActiveRunState = {
				sessionRecordId,
				jobId: job.jobId,
				startedAt: nowIso(),
			};
			activeRuns.set(sessionRecordId, runState);
			this.store.appendQueueEvent(agentId, toQueueEvent("start", job));
			this.syncRuntimeState(agentId);
			try {
				const result = await this.runJob(job);
				this.store.appendQueueEvent(agentId, toQueueEvent("complete", job));
				this.store.updateAgent(agentId, { lastError: null });
				this.store.audit(agentId, "queue.complete", {
					jobId: job.jobId,
					sessionRecordId: job.sessionRecordId,
					stopReason: result.stopReason,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.store.appendQueueEvent(agentId, toQueueEvent("fail", job, message));
				this.store.updateAgent(agentId, { lastError: message });
				this.store.audit(agentId, "queue.fail", {
					jobId: job.jobId,
					sessionRecordId: job.sessionRecordId,
					error: message,
				});
			} finally {
				queue.shift();
				if (queue.length === 0) {
					sessionQueues?.delete(sessionRecordId);
				}
			}
		}
		activeRuns.delete(sessionRecordId);
		this.syncRuntimeState(agentId);
		void this.dispatchAgent(agentId);
	}

	private pickNextSession(agentId: string): string | undefined {
		const sessionQueues = this.agentQueues.get(agentId);
		if (!sessionQueues || sessionQueues.size === 0) {
			return undefined;
		}
		const activeRuns = this.getActiveRuns(agentId);
		const candidates: Array<{ sessionRecordId: string; createdAt: string }> = [];
		for (const [sessionRecordId, queue] of sessionQueues.entries()) {
			if (queue.length === 0 || activeRuns.has(sessionRecordId)) {
				continue;
			}
			candidates.push({
				sessionRecordId,
				createdAt: queue[0]?.createdAt ?? "",
			});
		}
		candidates.sort(
			(left, right) =>
				left.createdAt.localeCompare(right.createdAt) || left.sessionRecordId.localeCompare(right.sessionRecordId),
		);
		return candidates[0]?.sessionRecordId;
	}

	private syncRuntimeState(agentId: string): void {
		const activeRuns = Array.from(this.getActiveRuns(agentId).values()).sort(
			(left, right) => left.startedAt.localeCompare(right.startedAt) || left.jobId.localeCompare(right.jobId),
		);
		this.store.writeRuntimeState({
			...this.store.getRuntimeState(agentId),
			agentId,
			currentJobId: activeRuns[0]?.jobId,
			activeRuns,
			updatedAt: nowIso(),
		});
	}

	private getOrCreateSessionQueues(agentId: string): SessionQueueMap {
		const existing = this.agentQueues.get(agentId);
		if (existing) {
			return existing;
		}
		const created = new Map<string, RunJob[]>();
		this.agentQueues.set(agentId, created);
		return created;
	}

	private getActiveRuns(agentId: string): ActiveRunMap {
		const existing = this.activeRunsByAgent.get(agentId);
		if (existing) {
			return existing;
		}
		const created = new Map<string, ActiveRunState>();
		this.activeRunsByAgent.set(agentId, created);
		return created;
	}

	private getTrackedJobCount(sessionQueues: SessionQueueMap): number {
		let count = 0;
		for (const queue of sessionQueues.values()) {
			count += queue.length;
		}
		return count;
	}

	private getQueuedWaitingCount(sessionQueues: SessionQueueMap | undefined, activeRuns: ActiveRunState[]): number {
		if (!sessionQueues || sessionQueues.size === 0) {
			return 0;
		}
		const activeSessionIds = new Set(activeRuns.map((run) => run.sessionRecordId));
		let count = 0;
		for (const [sessionRecordId, queue] of sessionQueues.entries()) {
			count += queue.length;
			if (queue.length > 0 && activeSessionIds.has(sessionRecordId)) {
				count -= 1;
			}
		}
		return count;
	}
}
