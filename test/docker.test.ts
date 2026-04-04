import { afterEach, describe, expect, it, vi } from "vitest";

describe("docker worker runtime", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("terminates timed out worker commands", async () => {
		vi.useFakeTimers();
		const kill = vi.fn();
		const handlers = new Map<string, (value?: unknown) => void>();
		const spawnMock = vi.fn(() => ({
			stdout: { on: vi.fn() },
			stderr: { on: vi.fn() },
			stdin: {
				write: vi.fn(),
				end: vi.fn(),
			},
			on: vi.fn((event: string, handler: (value?: unknown) => void) => {
				handlers.set(event, handler);
			}),
			kill,
		}));
		vi.doMock("node:child_process", () => ({
			spawn: spawnMock,
		}));

		const { runWorkerInContainer } = await import("../src/runtime/docker.js");
		const promise = runWorkerInContainer("daemon-cat", "{}\n", {});
		await vi.advanceTimersByTimeAsync(300_000);
		expect(kill).toHaveBeenNthCalledWith(1, "SIGTERM");
		await vi.advanceTimersByTimeAsync(5_000);
		expect(kill).toHaveBeenNthCalledWith(2, "SIGKILL");
		handlers.get("close")?.(null);
		await expect(promise).rejects.toThrow("Command timed out after 300000ms");
	});

	it("runs the worker from the mounted runtime root dist entrypoint", async () => {
		const { getNekoclawWorkerCommand } = await import("../src/runtime/docker.js");
		expect(getNekoclawWorkerCommand()).toEqual([
			"node",
			"/opt/nekoclaw-src/dist/cli.js",
			"__nekoclaw_internal",
			"worker",
			"run",
		]);
	});

	it("resolves the actual runtime mount root from the dependency layout", async () => {
		const { getNodeModulesRoot, getRuntimeMountRoot } = await import("../src/runtime/docker.js");
		const root = globalThis.process.cwd().replace(/\\/g, "/");
		expect(getNodeModulesRoot()).toBe(`${root}/node_modules`);
		expect(getRuntimeMountRoot()).toBe(root);
	});
});
