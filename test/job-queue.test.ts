import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobQueueService } from "../src/runtime/job-queue.js";
import { QueueFullError } from "../src/runtime/errors.js";
import type { RunJob, WorkerResult } from "../src/types.js";

describe("job queue", () => {
	let tempHome: string;
	const originalHome = process.env.HOME;

	beforeEach(() => {
		tempHome = mkdtempSync(join(tmpdir(), "nekoclaw-job-queue-"));
		process.env.HOME = tempHome;
		vi.resetModules();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		rmSync(tempHome, { recursive: true, force: true });
	});

	it("persists enqueue events before mutating the in-memory queue", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const store = new JsonNekoclawStore();
		const queues = new Map<string, RunJob[]>();
		const processing = new Set<string>();
		const agent = store.createAgent({ slug: "queue-cat" });
		const queue = new JobQueueService(store, queues, processing, async () => ({ outbound: {} }));
		const appendSpy = vi.spyOn(store, "appendQueueEvent").mockImplementation((agentId, event) => {
			expect(agentId).toBe(agent.agentId);
			expect(event.type).toBe("enqueue");
			expect(queues.get(agent.agentId) ?? []).toHaveLength(0);
		});
		const processSpy = vi.spyOn(queue, "processQueue").mockResolvedValue(undefined);

		await queue.enqueue({
			jobId: "job-1",
			agentId: agent.agentId,
			kind: "inbound",
			sessionRecordId: "session-1",
			sessionKey: "agent:queue-cat:telegram:direct:1",
			createdAt: "2026-03-29T00:00:00.000Z",
			event: {
				eventType: "message.created",
				channelType: "telegram",
				chatId: "1",
				chatKind: "dm",
				messageId: "m1",
				sender: {},
				blocks: [{ kind: "text", text: "hello" }],
				occurredAt: "2026-03-29T00:00:00.000Z",
			},
		});

		expect(appendSpy).toHaveBeenCalledTimes(1);
		expect(queues.get(agent.agentId)).toHaveLength(1);
		expect(processSpy).toHaveBeenCalledWith(agent.agentId);
	});

	it("compacts pending queue events during initialization", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const store = new JsonNekoclawStore();
		const agent = store.createAgent({ slug: "recover-cat" });
		const pendingJob: RunJob = {
			jobId: "job-pending",
			agentId: agent.agentId,
			kind: "inbound",
			sessionRecordId: "session-pending",
			sessionKey: "agent:recover-cat:telegram:direct:1",
			createdAt: "2026-03-29T00:00:00.000Z",
			event: {
				eventType: "message.created",
				channelType: "telegram",
				chatId: "1",
				chatKind: "dm",
				messageId: "m1",
				sender: {},
				blocks: [{ kind: "text", text: "pending" }],
				occurredAt: "2026-03-29T00:00:00.000Z",
			},
		};
		const finishedJob: RunJob = {
			...pendingJob,
			jobId: "job-done",
			sessionRecordId: "session-done",
			createdAt: "2026-03-29T00:01:00.000Z",
		};

		store.appendQueueEvent(agent.agentId, {
			type: "enqueue",
			jobId: pendingJob.jobId,
			timestamp: pendingJob.createdAt,
			job: pendingJob,
		});
		store.appendQueueEvent(agent.agentId, {
			type: "start",
			jobId: pendingJob.jobId,
			timestamp: "2026-03-29T00:00:10.000Z",
		});
		store.appendQueueEvent(agent.agentId, {
			type: "enqueue",
			jobId: finishedJob.jobId,
			timestamp: finishedJob.createdAt,
			job: finishedJob,
		});
		store.appendQueueEvent(agent.agentId, {
			type: "complete",
			jobId: finishedJob.jobId,
			timestamp: "2026-03-29T00:01:10.000Z",
		});

		const queues = new Map<string, RunJob[]>();
		const processing = new Set<string>();
		const queue = new JobQueueService(store, queues, processing, async (): Promise<WorkerResult> => ({ outbound: {} }));
		queue.initialize();

		expect(queues.get(agent.agentId)).toEqual([pendingJob]);
		expect(store.getQueueEvents(agent.agentId)).toEqual([
			{
				type: "enqueue",
				jobId: pendingJob.jobId,
				timestamp: pendingJob.createdAt,
				job: pendingJob,
			},
		]);
	});

	it("rejects enqueue when the queue reaches the depth limit", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const store = new JsonNekoclawStore();
		const queues = new Map<string, RunJob[]>();
		const processing = new Set<string>();
		const agent = store.createAgent({ slug: "busy-cat" });
		const existingJobs = Array.from({ length: 50 }, (_, index) => ({
			jobId: `job-${index}`,
			agentId: agent.agentId,
			kind: "inbound" as const,
			sessionRecordId: `session-${index}`,
			sessionKey: `agent:busy-cat:telegram:direct:${index}`,
			createdAt: `2026-03-29T00:${String(index).padStart(2, "0")}:00.000Z`,
			event: {
				eventType: "message.created" as const,
				channelType: "telegram" as const,
				chatId: String(index),
				chatKind: "dm" as const,
				messageId: `m-${index}`,
				sender: {},
				blocks: [{ kind: "text" as const, text: "queued" }],
				occurredAt: `2026-03-29T00:${String(index).padStart(2, "0")}:00.000Z`,
			},
		}));
		queues.set(agent.agentId, existingJobs);
		const queue = new JobQueueService(store, queues, processing, async () => ({ outbound: {} }));

		await expect(
			queue.enqueue({
				jobId: "job-overflow",
				agentId: agent.agentId,
				kind: "inbound",
				sessionRecordId: "session-overflow",
				sessionKey: "agent:busy-cat:telegram:direct:overflow",
				createdAt: "2026-03-29T02:00:00.000Z",
				event: {
					eventType: "message.created",
					channelType: "telegram",
					chatId: "overflow",
					chatKind: "dm",
					messageId: "m-overflow",
					sender: {},
					blocks: [{ kind: "text", text: "overflow" }],
					occurredAt: "2026-03-29T02:00:00.000Z",
				},
			}),
		).rejects.toBeInstanceOf(QueueFullError);
	});
});
