import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../src/types.js";

vi.mock("../src/runtime/docker.js", () => ({
	ensureAgentContainer: vi.fn(),
	inspectContainerStatus: vi.fn(),
	removeAgentContainer: vi.fn(async () => undefined),
	runWorkerInContainer: vi.fn(),
	stopAgentContainer: vi.fn(),
}));

describe("nekoclaw daemon", () => {
	let tempHome: string;
	const originalHome = process.env.HOME;

	beforeEach(() => {
		tempHome = mkdtempSync(join(tmpdir(), "nekoclaw-daemon-"));
		process.env.HOME = tempHome;
		vi.resetModules();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		rmSync(tempHome, { recursive: true, force: true });
	});

	it("removes local plugin state without re-reading the agent from store", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { NekoclawDaemon } = await import("../src/runtime/daemon.js");
		const docker = await import("../src/runtime/docker.js");
		const store = new JsonNekoclawStore();

		const agent = store.createAgent({ slug: "daemon-cat" });
		store.createChannel(agent.agentId, "telegram");
		store.setChannelToken(agent.agentId, "telegram", "telegram-token");

		const daemon = new NekoclawDaemon(store);
		const daemonState = daemon as unknown as {
			channelPlugins: Map<string, ChannelPlugin>;
			agentQueues: Map<string, unknown[]>;
			processingAgents: Set<string>;
		};
		const pluginStop = vi.fn();
		daemonState.channelPlugins.set(
			`${agent.agentId}:telegram`,
			{
				stop: pluginStop,
			} as unknown as ChannelPlugin,
		);
		daemonState.agentQueues.set(agent.agentId, [{ jobId: "job-1" }]);
		daemonState.processingAgents.add(agent.agentId);

		store.deleteAgent(agent.agentId, { force: true });
		await daemon.removeAgentRuntime(agent);

		expect(pluginStop).toHaveBeenCalledTimes(1);
		expect(daemonState.channelPlugins.size).toBe(0);
		expect(daemonState.agentQueues.has(agent.agentId)).toBe(false);
		expect(daemonState.processingAgents.has(agent.agentId)).toBe(false);
		expect(docker.removeAgentContainer).toHaveBeenCalledWith(agent.containerName);
		expect(store.getRuntimeState(agent.agentId).containerStatus).toBe("missing");
	}, 10_000);

	it("processes pending runtime removal control actions", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { NekoclawDaemon } = await import("../src/runtime/daemon.js");
		const store = new JsonNekoclawStore();

		const agent = store.createAgent({ slug: "signal-cat" });
		const daemon = new NekoclawDaemon(store);
		const daemonState = daemon as unknown as {
			channelPlugins: Map<string, ChannelPlugin>;
		};
		const pluginStop = vi.fn();
		daemonState.channelPlugins.set(
			`${agent.agentId}:telegram`,
			{
				stop: pluginStop,
			} as unknown as ChannelPlugin,
		);

		const action = store.createRuntimeControlAction({
			kind: "agent.remove_runtime",
			agent: {
				agentId: agent.agentId,
				slug: agent.slug,
				containerName: agent.containerName,
			},
		});
		await daemon.processRuntimeControlActions();

		expect(pluginStop).toHaveBeenCalledTimes(1);
		expect(store.getRuntimeControlAction(action.requestId)?.status).toBe("completed");
	});

	it("rejects new jobs while shutting down and drains in-flight work", async () => {
		vi.useFakeTimers();
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { NekoclawDaemon } = await import("../src/runtime/daemon.js");
		const store = new JsonNekoclawStore();

		const agent = store.createAgent({ slug: "drain-cat" });
		const daemon = new NekoclawDaemon(store);
		const daemonState = daemon as unknown as {
			processingAgents: Set<string>;
		};
		daemonState.processingAgents.add(agent.agentId);
		store.writeRuntimeProcessState({
			pid: process.pid,
			updatedAt: "2026-03-29T00:00:00.000Z",
		});

		setTimeout(() => {
			daemonState.processingAgents.delete(agent.agentId);
		}, 100);
		const stopPromise = daemon.stop();
		await expect(
			daemon.enqueue({
				jobId: "job-1",
				agentId: agent.agentId,
				kind: "inbound",
				sessionRecordId: "session-1",
				sessionKey: "agent:drain-cat:telegram:direct:1",
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
			}),
		).rejects.toMatchObject({ name: "RuntimeBusyError", code: "RUNTIME_BUSY" });

		await vi.advanceTimersByTimeAsync(200);
		await stopPromise;
		expect(store.getRuntimeProcessState().pid).toBeUndefined();
	});

	it("keeps the daemon alive when a channel plugin fails to start", async () => {
		vi.doMock("../src/channels/telegram.js", () => ({
			createTelegramChannelPlugin: vi.fn(() => ({
				startPolling: vi.fn(() => {
					throw new Error("telegram startup boom");
				}),
				stop: vi.fn(),
				type: "telegram",
				capabilities: {
					text: true,
					media: true,
					reply: true,
					edit: true,
					delete: true,
					typing: true,
				},
				outbound: { send: vi.fn() },
				actions: {
					send: vi.fn(),
					reply: vi.fn(),
					edit: vi.fn(),
					delete: vi.fn(),
					typing: vi.fn(),
				},
				threading: {
					resolveReplyMode: vi.fn(() => "off"),
					applyReplyMode: vi.fn((payload) => payload),
				},
				pairing: {
					shouldOfferPair: vi.fn(() => true),
					buildPairPrompt: vi.fn(() => ({ text: "pair" })),
					buildPairAccepted: vi.fn(() => ({ text: "ok" })),
					buildPairRejected: vi.fn(() => ({ text: "no" })),
				},
				triggering: {
					shouldProcessEvent: vi.fn(() => true),
				},
				resolveSessionAddress: vi.fn(),
			})),
		}));

		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { NekoclawDaemon } = await import("../src/runtime/daemon.js");
		const store = new JsonNekoclawStore();
		const agent = store.createAgent({ slug: "startup-error-cat" });
		store.createChannel(agent.agentId, "telegram");
		store.setChannelToken(agent.agentId, "telegram", "token");
		store.updateAgent(agent.agentId, { enabled: true });

			const daemon = new NekoclawDaemon(store);
			await expect(daemon.start()).resolves.toBeUndefined();
			expect(store.getAgentByRef(agent.agentId).lastError).toBe("telegram startup boom");
			await daemon.stop();
		});

	it("queues dream only for idle agents and records busy skips for agents already processing", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { NekoclawDaemon } = await import("../src/runtime/daemon.js");
		const store = new JsonNekoclawStore();

		const idleAgent = store.createAgent({ slug: "idle-dream-cat" });
		const busyAgent = store.createAgent({ slug: "busy-dream-cat" });
		const daemon = new NekoclawDaemon(store);
		const daemonState = daemon as unknown as {
			processingAgents: Set<string>;
			personaMemory: {
				queueBacklogSweep(agent: { agentId: string }): void;
				queueDream(agent: { agentId: string }): void;
				noteDreamSkip(agent: { agentId: string }, reason: "agent_busy"): void;
			};
			queuePersonaBacklogSweeps(): void;
		};
		daemonState.processingAgents.add(busyAgent.agentId);
		const backlogSpy = vi.spyOn(daemonState.personaMemory, "queueBacklogSweep");
		const dreamSpy = vi.spyOn(daemonState.personaMemory, "queueDream");
		const skipSpy = vi.spyOn(daemonState.personaMemory, "noteDreamSkip");

		daemonState.queuePersonaBacklogSweeps();

		expect(backlogSpy).toHaveBeenCalledTimes(1);
		expect(backlogSpy).toHaveBeenCalledWith(expect.objectContaining({ agentId: idleAgent.agentId }));
		expect(dreamSpy).toHaveBeenCalledTimes(1);
		expect(dreamSpy).toHaveBeenCalledWith(expect.objectContaining({ agentId: idleAgent.agentId }));
		expect(skipSpy).toHaveBeenCalledTimes(1);
		expect(skipSpy).toHaveBeenCalledWith(expect.objectContaining({ agentId: busyAgent.agentId }), "agent_busy");
	});

	it("enqueues due one-time crons as scheduled jobs and marks them completed", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { NekoclawDaemon } = await import("../src/runtime/daemon.js");
		const store = new JsonNekoclawStore();
		const agent = store.createAgent({ slug: "cron-once-cat" });
		const session = store.createSession(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "123",
			chatKind: "dm",
		});
		const cron = store.createSessionCron(agent.agentId, session.sessionRecordId, {
			scheduleKind: "once",
			message: "send the report",
			runAtLocal: "2000-01-01T07:00",
			timezone: "UTC",
		});
		const daemon = new NekoclawDaemon(store);
		const daemonState = daemon as unknown as {
			processDueCrons(): Promise<void>;
		};
		const enqueueSpy = vi.spyOn(daemon, "enqueue").mockResolvedValue(undefined);

		await daemonState.processDueCrons();

		expect(enqueueSpy).toHaveBeenCalledTimes(1);
		expect(enqueueSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "scheduled",
				sessionRecordId: session.sessionRecordId,
				scheduledReminder: expect.objectContaining({
					cronId: cron.cronId,
					message: "send the report",
					timezone: "UTC",
				}),
				event: expect.objectContaining({
					sender: expect.objectContaining({ displayName: "Scheduler" }),
					blocks: [{ kind: "text", text: "[Scheduled reminder due]\nsend the report" }],
				}),
			}),
		);
		expect(store.getCron(cron.cronId)?.status).toBe("completed");
	});

	it("advances due daily crons after enqueueing one scheduled job", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { NekoclawDaemon } = await import("../src/runtime/daemon.js");
		const store = new JsonNekoclawStore();
		const agent = store.createAgent({ slug: "cron-daily-cat" });
		const session = store.createSession(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "123",
			chatKind: "group",
			chatTitle: "Cron Group",
		});
		const cron = store.createSessionCron(agent.agentId, session.sessionRecordId, {
			scheduleKind: "daily",
			message: "daily standup",
			hour: 7,
			minute: 0,
			timezone: "UTC",
		});
		const cronPath = store.getCronPath(cron.cronId);
		const storedCron = JSON.parse(readFileSync(cronPath, "utf-8")) as Record<string, unknown>;
		storedCron.nextRunAt = "2000-01-01T07:00:00.000Z";
		writeFileSync(cronPath, `${JSON.stringify(storedCron, null, 2)}\n`, "utf-8");
		const daemon = new NekoclawDaemon(store);
		const daemonState = daemon as unknown as {
			processDueCrons(): Promise<void>;
		};
		const enqueueSpy = vi.spyOn(daemon, "enqueue").mockResolvedValue(undefined);

		await daemonState.processDueCrons();

		expect(enqueueSpy).toHaveBeenCalledTimes(1);
		const updated = store.getCron(cron.cronId);
		expect(updated?.status).toBe("active");
		expect(updated?.lastTriggeredAt).toBeTruthy();
		expect(updated?.nextRunAt).not.toBe("2000-01-01T07:00:00.000Z");
	});

	it("invalidates due crons when the bound session was reset or removed", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { NekoclawDaemon } = await import("../src/runtime/daemon.js");
		const store = new JsonNekoclawStore();
		const agent = store.createAgent({ slug: "cron-stale-cat" });
		const session = store.createSession(agent.agentId, {
			channelType: "napcat",
			externalConversationId: "456",
			chatKind: "group",
			chatTitle: "QQ Group",
		});
		const resetCron = store.createSessionCron(agent.agentId, session.sessionRecordId, {
			scheduleKind: "once",
			message: "stale reset cron",
			runAtLocal: "2000-01-01T07:00",
			timezone: "UTC",
		});
		store.resetSession(agent.agentId, session.sessionRecordId);
		const removedSession = store.createSession(agent.agentId, {
			channelType: "napcat",
			externalConversationId: "789",
			chatKind: "dm",
		});
		const removedCron = store.createSessionCron(agent.agentId, removedSession.sessionRecordId, {
			scheduleKind: "once",
			message: "missing session cron",
			runAtLocal: "2000-01-01T07:00",
			timezone: "UTC",
		});
		store.removeSession(agent.agentId, removedSession.sessionRecordId, { purge: true });
		const daemon = new NekoclawDaemon(store);
		const daemonState = daemon as unknown as {
			processDueCrons(): Promise<void>;
		};
		const enqueueSpy = vi.spyOn(daemon, "enqueue").mockResolvedValue(undefined);

		await daemonState.processDueCrons();

		expect(enqueueSpy).not.toHaveBeenCalled();
		expect(store.getCron(resetCron.cronId)?.status).toBe("invalidated");
		expect(store.getCron(removedCron.cronId)?.status).toBe("invalidated");
	});
	});
