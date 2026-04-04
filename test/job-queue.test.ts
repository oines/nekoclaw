import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobQueueService } from "../src/runtime/job-queue.js";
import { QueueFullError } from "../src/runtime/errors.js";
import type { RunJob, WorkerResult } from "../src/types.js";

function createJob(agentId: string, sessionRecordId: string, createdAt: string, chatId = sessionRecordId): RunJob {
	return {
		jobId: `job-${sessionRecordId}-${createdAt}`,
		agentId,
		kind: "inbound",
		sessionRecordId,
		sessionKey: `agent:test:telegram:direct:${sessionRecordId}`,
		createdAt,
		event: {
			eventType: "message.created",
			channelType: "telegram",
			chatId,
			chatKind: "dm",
			messageId: `m-${sessionRecordId}-${createdAt}`,
			sender: {},
			blocks: [{ kind: "text", text: "hello" }],
			occurredAt: createdAt,
		},
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function flushMicrotasks(times = 3): Promise<void> {
	for (let index = 0; index < times; index += 1) {
		await Promise.resolve();
	}
}

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

	it("persists enqueue events before mutating the in-memory session queue", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const store = new JsonNekoclawStore();
		const queues = new Map<string, Map<string, RunJob[]>>();
		const activeRunsByAgent = new Map<string, Map<string, { sessionRecordId: string; jobId: string; startedAt: string }>>();
		const agent = store.createAgent({ slug: "queue-cat" });
		const queue = new JobQueueService(store, queues, activeRunsByAgent, async () => ({ outbound: {} }));
		const appendSpy = vi.spyOn(store, "appendQueueEvent").mockImplementation((agentId, event) => {
			expect(agentId).toBe(agent.agentId);
			if (event.type === "enqueue") {
				expect(queues.get(agent.agentId)?.get("session-1") ?? []).toHaveLength(0);
			}
		});

		await queue.enqueue(createJob(agent.agentId, "session-1", "2026-03-29T00:00:00.000Z", "1"));

		expect(appendSpy).toHaveBeenCalled();
		expect(appendSpy.mock.calls.map(([, event]) => event.type)).toEqual(["enqueue", "start", "complete"]);
	});

	it("starts prefetch on enqueue and allows waiting only for the immediate first job", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const store = new JsonNekoclawStore();
		const queues = new Map<string, Map<string, RunJob[]>>();
		const activeRunsByAgent = new Map<string, Map<string, { sessionRecordId: string; jobId: string; startedAt: string }>>();
		const agent = store.createAgent({ slug: "prefetch-queue-cat" });
		const contexts: Array<{ jobId: string; allowPersonaPrefetchWait: boolean }> = [];
		const gates = new Map<string, ReturnType<typeof deferred<WorkerResult>>>();
		const onEnqueued = vi.fn();
		const onRemoved = vi.fn();
		const queue = new JobQueueService(
			store,
			queues,
			activeRunsByAgent,
			async (job, context) => {
				contexts.push({ jobId: job.jobId, allowPersonaPrefetchWait: context.allowPersonaPrefetchWait });
				const gate = deferred<WorkerResult>();
				gates.set(job.jobId, gate);
				return gate.promise;
			},
			{ onEnqueued, onRemoved },
		);

		const first = createJob(agent.agentId, "session-a", "2026-03-29T00:00:00.000Z", "a");
		const second = createJob(agent.agentId, "session-a", "2026-03-29T00:00:01.000Z", "a");

		await queue.enqueue(first);
		await flushMicrotasks();
		expect(onEnqueued).toHaveBeenCalledWith(first);
		expect(contexts).toEqual([{ jobId: first.jobId, allowPersonaPrefetchWait: true }]);

		await queue.enqueue(second);
		await flushMicrotasks();
		expect(onEnqueued).toHaveBeenCalledWith(second);
		expect(contexts).toEqual([{ jobId: first.jobId, allowPersonaPrefetchWait: true }]);

		gates.get(first.jobId)?.resolve({ outbound: {} });
		await flushMicrotasks(6);

		expect(contexts).toEqual([
			{ jobId: first.jobId, allowPersonaPrefetchWait: true },
			{ jobId: second.jobId, allowPersonaPrefetchWait: false },
		]);
		expect(onRemoved).toHaveBeenCalledWith([first]);

		gates.get(second.jobId)?.resolve({ outbound: {} });
		await flushMicrotasks(6);
		expect(onRemoved).toHaveBeenCalledWith([second]);
	});

	it("compacts pending queue events during initialization", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const store = new JsonNekoclawStore();
		const agent = store.createAgent({ slug: "recover-cat" });
		const pendingJob = createJob(agent.agentId, "session-pending", "2026-03-29T00:00:00.000Z", "1");
		const finishedJob = createJob(agent.agentId, "session-done", "2026-03-29T00:01:00.000Z", "2");

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

		const queues = new Map<string, Map<string, RunJob[]>>();
		const activeRunsByAgent = new Map<string, Map<string, { sessionRecordId: string; jobId: string; startedAt: string }>>();
		const queue = new JobQueueService(store, queues, activeRunsByAgent, async (): Promise<WorkerResult> => ({ outbound: {} }));
		queue.initialize();

		expect(queues.get(agent.agentId)?.get("session-pending")).toEqual([pendingJob]);
		expect(store.getQueueEvents(agent.agentId)).toEqual([
			{
				type: "enqueue",
				jobId: pendingJob.jobId,
				timestamp: pendingJob.createdAt,
				job: pendingJob,
			},
		]);
	});

	it("rejects enqueue when the agent reaches the total depth limit across sessions", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const store = new JsonNekoclawStore();
		const queues = new Map<string, Map<string, RunJob[]>>();
		const activeRunsByAgent = new Map<string, Map<string, { sessionRecordId: string; jobId: string; startedAt: string }>>();
		const agent = store.createAgent({ slug: "busy-cat" });
		const sessionQueues = new Map<string, RunJob[]>();
		for (let index = 0; index < 50; index += 1) {
			sessionQueues.set(`session-${index}`, [
				createJob(agent.agentId, `session-${index}`, `2026-03-29T00:${String(index).padStart(2, "0")}:00.000Z`, String(index)),
			]);
		}
		queues.set(agent.agentId, sessionQueues);
		const queue = new JobQueueService(store, queues, activeRunsByAgent, async () => ({ outbound: {} }));

		await expect(
			queue.enqueue(createJob(agent.agentId, "session-overflow", "2026-03-29T02:00:00.000Z", "overflow")),
		).rejects.toBeInstanceOf(QueueFullError);
	});

	it("runs different sessions concurrently up to the agent concurrency limit", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const store = new JsonNekoclawStore();
		const queues = new Map<string, Map<string, RunJob[]>>();
		const activeRunsByAgent = new Map<string, Map<string, { sessionRecordId: string; jobId: string; startedAt: string }>>();
		const agent = store.createAgent({ slug: "parallel-cat" });
		const gates = new Map<string, ReturnType<typeof deferred<WorkerResult>>>();
		const starts: string[] = [];
		const queue = new JobQueueService(store, queues, activeRunsByAgent, async (job) => {
			starts.push(job.sessionRecordId);
			const gate = deferred<WorkerResult>();
			gates.set(job.sessionRecordId, gate);
			return gate.promise;
		});

		await queue.enqueue(createJob(agent.agentId, "session-a", "2026-03-29T00:00:00.000Z", "a"));
		await queue.enqueue(createJob(agent.agentId, "session-b", "2026-03-29T00:00:01.000Z", "b"));
		await queue.enqueue(createJob(agent.agentId, "session-c", "2026-03-29T00:00:02.000Z", "c"));
		await flushMicrotasks();

		expect(starts).toEqual(["session-a", "session-b"]);
		expect(queue.getStatus(agent.agentId)).toMatchObject({
			queued: 1,
			runningSessions: 2,
			maxConcurrentSessions: 2,
		});

		gates.get("session-a")?.resolve({ outbound: {} });
		await flushMicrotasks(6);

		expect(starts).toEqual(["session-a", "session-b", "session-c"]);
		expect(queue.getStatus(agent.agentId)).toMatchObject({
			queued: 0,
			runningSessions: 2,
		});

		gates.get("session-b")?.resolve({ outbound: {} });
		gates.get("session-c")?.resolve({ outbound: {} });
		await flushMicrotasks(6);

		expect(queue.getStatus(agent.agentId)).toMatchObject({
			queued: 0,
			runningSessions: 0,
			processing: false,
		});
	});

	it("keeps jobs within the same session strictly serial while another session runs", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const store = new JsonNekoclawStore();
		const queues = new Map<string, Map<string, RunJob[]>>();
		const activeRunsByAgent = new Map<string, Map<string, { sessionRecordId: string; jobId: string; startedAt: string }>>();
		const agent = store.createAgent({ slug: "serial-cat" });
		const gates = new Map<string, ReturnType<typeof deferred<WorkerResult>>>();
		const starts: string[] = [];
		const queue = new JobQueueService(store, queues, activeRunsByAgent, async (job) => {
			starts.push(job.jobId);
			const gate = deferred<WorkerResult>();
			gates.set(job.jobId, gate);
			return gate.promise;
		});

		const a1 = createJob(agent.agentId, "session-a", "2026-03-29T00:00:00.000Z", "a");
		const a2 = createJob(agent.agentId, "session-a", "2026-03-29T00:00:01.000Z", "a");
		const b1 = createJob(agent.agentId, "session-b", "2026-03-29T00:00:02.000Z", "b");

		await queue.enqueue(a1);
		await queue.enqueue(a2);
		await queue.enqueue(b1);
		await flushMicrotasks();

		expect(starts).toEqual([a1.jobId, b1.jobId]);

		gates.get(b1.jobId)?.resolve({ outbound: {} });
		await flushMicrotasks(6);
		expect(starts).toEqual([a1.jobId, b1.jobId]);

		gates.get(a1.jobId)?.resolve({ outbound: {} });
		await flushMicrotasks(6);
		expect(starts).toEqual([a1.jobId, b1.jobId, a2.jobId]);
		expect(queue.getStatus(agent.agentId)).toMatchObject({
			queued: 0,
			runningSessions: 1,
		});

		gates.get(a2.jobId)?.resolve({ outbound: {} });
		await flushMicrotasks(6);
		expect(queue.getStatus(agent.agentId)).toMatchObject({
			queued: 0,
			runningSessions: 0,
		});
	});

	it("clears all queued jobs for an idle session through stopSession", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const store = new JsonNekoclawStore();
		const queues = new Map<string, Map<string, RunJob[]>>();
		const activeRunsByAgent = new Map<string, Map<string, { sessionRecordId: string; jobId: string; startedAt: string }>>();
		const agent = store.createAgent({ slug: "stop-idle-cat" });
		const queue = new JobQueueService(store, queues, activeRunsByAgent, async () => ({ outbound: {} }));
		const sessionQueues = new Map<string, RunJob[]>();
		const a1 = createJob(agent.agentId, "session-a", "2026-03-29T00:00:00.000Z", "a");
		const a2 = createJob(agent.agentId, "session-a", "2026-03-29T00:00:01.000Z", "a");
		const b1 = createJob(agent.agentId, "session-b", "2026-03-29T00:00:02.000Z", "b");
		sessionQueues.set("session-a", [a1, a2]);
		sessionQueues.set("session-b", [b1]);
		queues.set(agent.agentId, sessionQueues);

		const result = queue.stopSession(agent.agentId, "session-a");

		expect(result).toEqual({ removedQueuedCount: 2, hadQueuedWork: true, interruptedActiveRun: false });
		expect(queues.get(agent.agentId)?.has("session-a")).toBe(false);
		expect(queues.get(agent.agentId)?.get("session-b")).toEqual([b1]);
		expect(store.recoverPendingJobs(agent.agentId)).toEqual([b1]);
	});

	it("preserves the current running job and clears only tail jobs for an active session", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const store = new JsonNekoclawStore();
		const queues = new Map<string, Map<string, RunJob[]>>();
		const activeRunsByAgent = new Map<string, Map<string, { sessionRecordId: string; jobId: string; startedAt: string }>>();
		const agent = store.createAgent({ slug: "stop-active-cat" });
		const queue = new JobQueueService(store, queues, activeRunsByAgent, async () => ({ outbound: {} }));
		const a1 = createJob(agent.agentId, "session-a", "2026-03-29T00:00:00.000Z", "a");
		const a2 = createJob(agent.agentId, "session-a", "2026-03-29T00:00:01.000Z", "a");
		const a3 = createJob(agent.agentId, "session-a", "2026-03-29T00:00:02.000Z", "a");
		const b1 = createJob(agent.agentId, "session-b", "2026-03-29T00:00:03.000Z", "b");
		queues.set(agent.agentId, new Map([
			["session-a", [a1, a2, a3]],
			["session-b", [b1]],
		]));
		activeRunsByAgent.set(agent.agentId, new Map([
			["session-a", { sessionRecordId: "session-a", jobId: a1.jobId, startedAt: "2026-03-29T00:00:10.000Z" }],
		]));

		const result = queue.stopSession(agent.agentId, "session-a");

		expect(result).toEqual({ removedQueuedCount: 2, hadQueuedWork: true, interruptedActiveRun: false });
		expect(queues.get(agent.agentId)?.get("session-a")).toEqual([a1]);
		expect(queues.get(agent.agentId)?.get("session-b")).toEqual([b1]);
		expect(store.recoverPendingJobs(agent.agentId)).toEqual([a1, b1]);
	});

	it("aborts the active run and drops queued tail work for the stopped session", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const store = new JsonNekoclawStore();
		const queues = new Map<string, Map<string, RunJob[]>>();
		const activeRunsByAgent = new Map<string, Map<string, { sessionRecordId: string; jobId: string; startedAt: string }>>();
		const agent = store.createAgent({ slug: "stop-cancel-cat" });
		const starts: string[] = [];
		const gates = new Map<string, ReturnType<typeof deferred<WorkerResult>>>();
		const queue = new JobQueueService(store, queues, activeRunsByAgent, async (job, context) => {
			starts.push(job.jobId);
			const gate = deferred<WorkerResult>();
			gates.set(job.jobId, gate);
			context.signal?.addEventListener(
				"abort",
				() => {
					gate.reject(context.signal?.reason);
				},
				{ once: true },
			);
			return gate.promise;
		});

		const a1 = createJob(agent.agentId, "session-a", "2026-03-29T00:00:00.000Z", "a");
		const a2 = createJob(agent.agentId, "session-a", "2026-03-29T00:00:01.000Z", "a");
		const b1 = createJob(agent.agentId, "session-b", "2026-03-29T00:00:02.000Z", "b");

		await queue.enqueue(a1);
		await queue.enqueue(a2);
		await queue.enqueue(b1);
		await flushMicrotasks(6);

		expect(starts).toEqual([a1.jobId, b1.jobId]);
		expect(queue.getStatus(agent.agentId)).toMatchObject({
			runningSessions: 2,
			queued: 1,
		});

		const result = queue.stopSession(agent.agentId, "session-a");
		await flushMicrotasks(8);

		expect(result).toEqual({ removedQueuedCount: 1, hadQueuedWork: true, interruptedActiveRun: true });
		expect(queues.get(agent.agentId)?.has("session-a")).toBe(false);
		expect(store.getQueueEvents(agent.agentId).map((event) => ({ type: event.type, jobId: event.jobId }))).toEqual([
			{ type: "enqueue", jobId: a1.jobId },
			{ type: "enqueue", jobId: b1.jobId },
			{ type: "cancel", jobId: a1.jobId },
		]);
		expect(store.recoverPendingJobs(agent.agentId)).toEqual([b1]);
		expect(queue.getStatus(agent.agentId)).toMatchObject({
			runningSessions: 1,
			queued: 0,
		});

		gates.get(b1.jobId)?.resolve({ outbound: {} });
		await flushMicrotasks(8);

		expect(store.getQueueEvents(agent.agentId).map((event) => event.type)).toEqual(["enqueue", "enqueue", "cancel", "complete"]);
		expect(store.recoverPendingJobs(agent.agentId)).toEqual([]);
		expect(queue.getStatus(agent.agentId)).toMatchObject({
			runningSessions: 0,
			queued: 0,
			processing: false,
		});
	});
});
