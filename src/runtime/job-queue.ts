import { JsonNekoclawStore } from "../store/json-store.js";
import type { QueueEvent, RunJob, WorkerResult } from "../types.js";
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

export class JobQueueService {
	constructor(
		private readonly store: JsonNekoclawStore,
		private readonly agentQueues: Map<string, RunJob[]>,
		private readonly processingAgents: Set<string>,
		private readonly runJob: (job: RunJob) => Promise<WorkerResult>,
	) {}

	initialize(): void {
		for (const agent of this.store.listAgents()) {
			const jobs = this.store.recoverPendingJobs(agent.agentId);
			this.agentQueues.set(agent.agentId, jobs);
			this.compactQueueLog(agent.agentId, jobs);
		}
	}

	async enqueue(job: RunJob): Promise<void> {
		const queue = this.agentQueues.get(job.agentId) ?? [];
		if (queue.length >= MAX_QUEUE_DEPTH) {
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
		queue.push(job);
		this.agentQueues.set(job.agentId, queue);
		this.store.audit(job.agentId, "queue.enqueue", {
			jobId: job.jobId,
			sessionRecordId: job.sessionRecordId,
			sessionKey: job.sessionKey,
		});
		void this.processQueue(job.agentId);
	}

	async processQueue(agentId: string): Promise<void> {
		if (this.processingAgents.has(agentId)) {
			return;
		}
		this.processingAgents.add(agentId);
		try {
			const queue = this.agentQueues.get(agentId) ?? [];
			while (queue.length > 0) {
				const job = queue[0];
				this.store.appendQueueEvent(agentId, toQueueEvent("start", job));
				this.store.writeRuntimeState({
					...this.store.getRuntimeState(agentId),
					currentJobId: job.jobId,
					updatedAt: nowIso(),
				});
				try {
					const result = await this.runJob(job);
					this.store.appendQueueEvent(agentId, toQueueEvent("complete", job));
					this.store.updateAgent(agentId, { lastError: null });
					this.store.audit(agentId, "queue.complete", {
						jobId: job.jobId,
						stopReason: result.stopReason,
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					this.store.appendQueueEvent(agentId, toQueueEvent("fail", job, message));
					this.store.updateAgent(agentId, { lastError: message });
					this.store.audit(agentId, "queue.fail", {
						jobId: job.jobId,
						error: message,
					});
				} finally {
					queue.shift();
					this.store.writeRuntimeState({
						...this.store.getRuntimeState(agentId),
						currentJobId: undefined,
						updatedAt: nowIso(),
					});
				}
			}
		} finally {
			this.processingAgents.delete(agentId);
		}
	}

	clearAgent(agentId: string): void {
		this.agentQueues.delete(agentId);
		this.processingAgents.delete(agentId);
	}

	compactQueueLog(agentId: string, jobs = this.agentQueues.get(agentId) ?? []): void {
		const events: QueueEvent[] = jobs.map((job) => ({
			type: "enqueue",
			jobId: job.jobId,
			timestamp: job.createdAt,
			job,
		}));
		this.store.rewriteQueueEvents(agentId, events);
	}

	compactIdleQueues(): void {
		for (const [agentId, jobs] of this.agentQueues.entries()) {
			if (jobs.length === 0 && !this.processingAgents.has(agentId)) {
				this.compactQueueLog(agentId, jobs);
			}
		}
	}

	getStatus(agentId: string): { queued: number; processing: boolean; currentJobId?: string } {
		return {
			queued: this.agentQueues.get(agentId)?.length ?? 0,
			processing: this.processingAgents.has(agentId),
			currentJobId: this.store.getRuntimeState(agentId).currentJobId,
		};
	}
}
