import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NekoclawDaemon } from "../src/runtime/daemon.js";

describe("nekoclaw handlers", () => {
	let tempHome: string;
	const originalHome = process.env.HOME;

	beforeEach(() => {
		tempHome = mkdtempSync(join(tmpdir(), "nekoclaw-handlers-"));
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

	it("keeps the agent config when runtime cleanup fails during removal", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { handleAgentRemove } = await import("../src/cli/handlers/index.js");
		const store = new JsonNekoclawStore();

		const agent = store.createAgent({ slug: "stubborn-cat" });
		store.createChannel(agent.agentId, "telegram");

		const daemon = {
			removeAgentRuntime: vi.fn(async () => {
				throw new Error("docker rm failed");
			}),
		} as unknown as NekoclawDaemon;

		await expect(handleAgentRemove(agent.slug, { force: true }, store, daemon)).rejects.toThrow("docker rm failed");
		expect(store.getAgentByRef(agent.slug).slug).toBe(agent.slug);
		expect(store.listChannels(agent.agentId)).toHaveLength(1);
	}, 10_000);

	it("removes runtime state before deleting the agent config", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { handleAgentRemove } = await import("../src/cli/handlers/index.js");
		const store = new JsonNekoclawStore();

		const agent = store.createAgent({ slug: "copy-cat" });
		store.createChannel(agent.agentId, "telegram");

		const daemon = {
			removeAgentRuntime: vi.fn(async () => {
				expect(store.getAgentByRef(agent.slug).slug).toBe(agent.slug);
			}),
		} as unknown as NekoclawDaemon;

		await handleAgentRemove(agent.slug, { force: true }, store, daemon);
		expect(() => store.getAgentByRef(agent.slug)).toThrow(`Unknown agent "${agent.slug}"`);
	});

	it("reports explicit provider ids for custom model endpoints in CLI output", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { handleAgentList, handleModelCurrent } = await import("../src/cli/handlers/index.js");
		const store = new JsonNekoclawStore();

		const alpha = store.createAgent({ slug: "alpha-proxy" });
		const beta = store.createAgent({ slug: "beta-proxy" });
		const alphaAgent = store.setCustomModelConfig(alpha.agentId, {
			baseUrl: "https://alpha.example/v1",
			api: "openai-completions",
			providerId: "alpha",
			modelId: "claude-sonnet-4-6",
			apiKey: "alpha-key",
		});
		const betaAgent = store.setCustomModelConfig(beta.agentId, {
			baseUrl: "https://beta.example/v1",
			api: "openai-completions",
			providerId: "beta",
			modelId: "claude-sonnet-4-6",
			apiKey: "beta-key",
		});
		expect(alphaAgent.provider).not.toBe(betaAgent.provider);

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
		await handleModelCurrent(alpha.slug, store);
		await handleModelCurrent(beta.slug, store);
		await handleAgentList(store);

		const output = logSpy.mock.calls
			.flatMap((call) => call.map((value) => String(value)))
			.join("\n");
		expect(output).toContain(`${alphaAgent.provider}/claude-sonnet-4-6`);
		expect(output).toContain(`${betaAgent.provider}/claude-sonnet-4-6`);
	});

	it("includes the canonical session key in session list output", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { handleSessionList } = await import("../src/cli/handlers/index.js");
		const store = new JsonNekoclawStore();

		const agent = store.createAgent({ slug: "cat-agent" });
		store.createSession(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "12345",
			chatKind: "dm",
		});

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
		await handleSessionList(agent.slug, store);

		const output = logSpy.mock.calls
			.flatMap((call) => call.map((value) => String(value)))
			.join("\n");
		expect(output).toContain("SESSION KEY");
		expect(output).toContain("agent:cat-agent:telegram:direct:12345");
	});

	it("adds, lists, and removes admins through CLI handlers", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { handleAdminAdd, handleAdminList, handleAdminRemove } = await import("../src/cli/handlers/index.js");
		const store = new JsonNekoclawStore();

		const agent = store.createAgent({ slug: "ops-cat" });
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

		await handleAdminAdd(agent.slug, "telegram", "999", store);
		await handleAdminList(agent.slug, store);
		await handleAdminRemove(agent.slug, "telegram", "999", store);

		const output = logSpy.mock.calls
			.flatMap((call) => call.map((value) => String(value)))
			.join("\n");
		expect(output).toContain("Added admin telegram/999 to ops-cat");
		expect(output).toContain("CHANNEL");
		expect(output).toContain("USER ID");
		expect(output).toContain("telegram");
		expect(output).toContain("999");
		expect(output).toContain("Removed admin telegram/999 from ops-cat");
		expect(store.listAdmins(agent.agentId)).toHaveLength(0);
	});

	it("configures a napcat channel with endpoint and access token", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { handleChannelAdd, handleChannelEndpoint, handleChannelToken, handleChannelTrigger, handleAgentEnable } = await import("../src/cli/handlers/index.js");
		const store = new JsonNekoclawStore();

		const agent = store.createAgent({ slug: "qq-cat" });
		store.setBuiltinModelConfig(agent.agentId, {
			provider: "openrouter",
			modelId: "z-ai/glm-4.7-flash",
			apiKey: "test-key",
		});

		await handleChannelAdd(agent.slug, "napcat", store);
		await handleChannelEndpoint(agent.slug, "napcat", { url: "ws://127.0.0.1:3001", selfId: "123456789" }, store);
		await handleChannelToken(agent.slug, "napcat", { token: "napcat-token" }, store);
		await handleChannelTrigger(agent.slug, "napcat", { group: "mention" }, store);
		await handleAgentEnable(agent.slug, store, {} as NekoclawDaemon);

		const config = store.getNapcatChannelConfig(agent.agentId);
		expect(config?.wsUrl).toBe("ws://127.0.0.1:3001");
		expect(config?.selfId).toBe("123456789");
		expect(config?.accessToken).toBe("napcat-token");
		expect(config?.groupTrigger).toBe("mention");
		expect(store.getAgentByRef(agent.slug).enabled).toBe(true);
	});

	it("preserves node execArgv when spawning the background runtime", async () => {
		const spawnMock = vi.fn(() => ({
			pid: 12345,
			unref: vi.fn(),
		}));
		vi.doMock("node:child_process", () => ({
			spawn: spawnMock,
		}));

		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { handleRuntimeStart } = await import("../src/cli/handlers/index.js");
		const store = new JsonNekoclawStore();

		await handleRuntimeStart(store);

		expect(spawnMock).toHaveBeenCalledTimes(1);
		expect(spawnMock.mock.calls[0]?.[0]).toBe(process.execPath);
		expect(spawnMock.mock.calls[0]?.[1]).toEqual([
			...process.execArgv,
			process.argv[1],
			"__nekoclaw_internal",
			"runtime",
		]);
		expect(store.getRuntimeProcessState().pid).toBe(12345);
	});

	it("spawns only one runtime when enables race", async () => {
		const spawnMock = vi.fn(() => ({
			pid: process.pid,
			unref: vi.fn(),
		}));
		vi.doMock("node:child_process", () => ({
			spawn: spawnMock,
		}));

		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { handleRuntimeStart } = await import("../src/cli/handlers/index.js");
		const store = new JsonNekoclawStore();

		await Promise.all([handleRuntimeStart(store), handleRuntimeStart(store)]);

		expect(spawnMock).toHaveBeenCalledTimes(1);
	});

	it("treats napcat handshake fatals with socket-hang-up stacks as recoverable runtime errors", async () => {
		const { isRecoverableRuntimeError } = await import("../src/cli/handlers/runtime.js");
		const error = new Error("Fatal! more info see: {}");
		error.stack = `Error: Fatal! more info see: {}
    at Client.connectHandler (onebot-client-next)
    at emitErrorEvent (node:_http_client:109:11)
    at ClientRequest.<anonymous>
Caused by: socket hang up`;

		expect(isRecoverableRuntimeError(error)).toBe(true);
	});

	it("enables an agent without starting the runtime or container", async () => {
		const spawnMock = vi.fn();
		vi.doMock("node:child_process", () => ({
			spawn: spawnMock,
		}));

		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { handleAgentEnable } = await import("../src/cli/handlers/index.js");
		const store = new JsonNekoclawStore();

		const agent = store.createAgent({ slug: "deferred-cat" });
		store.setBuiltinModelConfig(agent.agentId, {
			provider: "openrouter",
			modelId: "z-ai/glm-4.7-flash",
			apiKey: "test-key",
		});
		store.createChannel(agent.agentId, "telegram");
		store.setChannelToken(agent.agentId, "telegram", "telegram-token");

		const daemon = {
			startAgentContainer: vi.fn(async () => "running"),
		} as unknown as NekoclawDaemon;

		await handleAgentEnable(agent.slug, store, daemon);

		expect(store.getAgentByRef(agent.slug).enabled).toBe(true);
		expect(spawnMock).not.toHaveBeenCalled();
		expect(daemon.startAgentContainer).not.toHaveBeenCalled();
	});

	it("stops only the target agent container when disabling", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { handleAgentDisable } = await import("../src/cli/handlers/index.js");
		const store = new JsonNekoclawStore();

		const agent = store.createAgent({ slug: "sleepy-cat" });
		store.updateAgent(agent.agentId, { enabled: true });
		const daemon = {
			stopAgentContainer: vi.fn(async () => undefined),
		} as unknown as NekoclawDaemon;

		await handleAgentDisable(agent.slug, store, daemon);

		expect(store.getAgentByRef(agent.slug).enabled).toBe(false);
		expect(daemon.stopAgentContainer).toHaveBeenCalledWith(agent.agentId);
	});

	it("restarts the shared runtime daemon and starts a replacement process", async () => {
		const spawnMock = vi.fn(() => ({
			pid: process.pid,
			unref: vi.fn(),
		}));
		let alive = true;
		const killMock = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
			if (signal === 0 || signal === undefined) {
				if (!alive) {
					throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
				}
				return true;
			}
			if (signal === "SIGTERM" || signal === "SIGKILL") {
				alive = false;
			}
			return true;
		}) as typeof process.kill);
		vi.doMock("node:child_process", () => ({
			spawn: spawnMock,
		}));

		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { handleRuntimeRestart } = await import("../src/cli/handlers/index.js");
		const store = new JsonNekoclawStore();
		store.writeRuntimeProcessState({
			pid: process.pid,
			updatedAt: "2026-03-29T00:00:00.000Z",
		});

		await handleRuntimeRestart(store);

		expect(killMock).toHaveBeenCalledWith(process.pid, "SIGTERM");
		expect(spawnMock).toHaveBeenCalledTimes(1);
		expect(store.getRuntimeProcessState().pid).toBe(process.pid);
	});

	it("stops the shared runtime daemon without changing enabled agents", async () => {
		let alive = true;
		const killMock = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
			if (signal === 0 || signal === undefined) {
				if (!alive) {
					throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
				}
				return true;
			}
			if (signal === "SIGTERM" || signal === "SIGKILL") {
				alive = false;
			}
			return true;
		}) as typeof process.kill);

		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { handleRuntimeStop } = await import("../src/cli/handlers/index.js");
		const store = new JsonNekoclawStore();
		const agent = store.createAgent({ slug: "steady-cat" });
		store.updateAgent(agent.agentId, { enabled: true });
		store.writeRuntimeProcessState({
			pid: process.pid,
			updatedAt: "2026-03-29T00:00:00.000Z",
		});

		await handleRuntimeStop(store);

		expect(killMock).toHaveBeenCalledWith(process.pid, "SIGTERM");
		expect(store.getAgentByRef(agent.slug).enabled).toBe(true);
		expect(store.getRuntimeProcessState().pid).toBeUndefined();
	});

	it("shows shared runtime status and an overall agent summary", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { handleStatus } = await import("../src/cli/handlers/index.js");
		const store = new JsonNekoclawStore();
		const enabled = store.createAgent({ slug: "alpha-cat" });
		const disabled = store.createAgent({ slug: "beta-cat" });
		store.updateAgent(enabled.agentId, { enabled: true });
		store.createChannel(enabled.agentId, "telegram");
		store.createChannel(disabled.agentId, "napcat");
		store.createSession(enabled.agentId, {
			channelType: "telegram",
			externalConversationId: "12345",
			chatKind: "dm",
		});
		store.writeRuntimeProcessState({
			pid: process.pid,
			updatedAt: "2026-03-29T00:00:00.000Z",
		});

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
		await handleStatus(store);

		const output = logSpy.mock.calls
			.flatMap((call) => call.map((value) => String(value)))
			.join("\n");
		expect(output).toContain("nekoclaw status");
		expect(output).toContain("Runtime: running");
		expect(output).toContain(`PID: ${process.pid}`);
		expect(output).toContain("Agents: 2 total (1 enabled)");
		expect(output).toContain("Channels: 2");
		expect(output).toContain("Sessions: 1");
		expect(output).toContain("Enabled agents: alpha-cat");
	});
});
