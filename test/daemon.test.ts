import { mkdtempSync, rmSync } from "node:fs";
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
	});

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
});
