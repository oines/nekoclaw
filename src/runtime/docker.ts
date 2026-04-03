import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { basename, dirname, relative, resolve } from "node:path";
import { NEKOCLAW_CONTAINER_CODE_DIR, NEKOCLAW_CONTAINER_WORKSPACE_DIR } from "../config.js";
import type { AgentSpec } from "../types.js";

function getPackageRoot(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "../..");
}

export function getNodeModulesRoot(): string {
	const require = createRequire(import.meta.url);
	const resolvedEntry = require.resolve("chalk");
	let current = dirname(resolvedEntry);
	while (basename(current) !== "node_modules") {
		const parent = dirname(current);
		if (parent === current) {
			throw new Error("Could not locate node_modules for nekoclaw worker runtime");
		}
		current = parent;
	}
	return current;
}

export function getRuntimeMountRoot(): string {
	return dirname(getNodeModulesRoot());
}

function getContainerWorkerEntrypoint(): string {
	const mountRoot = getRuntimeMountRoot();
	const packageRoot = getPackageRoot();
	const packageRelativePath = relative(mountRoot, packageRoot);
	const normalizedPrefix = packageRelativePath && packageRelativePath !== "." ? `${packageRelativePath}/` : "";
	return `${NEKOCLAW_CONTAINER_CODE_DIR}/${normalizedPrefix}dist/cli.js`;
}

function runCommand(
	command: string,
	args: string[],
	options: { input?: string; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, {
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";

		child.stdout.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		let timedOut = false;
		let killTimer: NodeJS.Timeout | undefined;
		const timer =
			options.timeoutMs !== undefined
				? setTimeout(() => {
						timedOut = true;
						child.kill("SIGTERM");
						killTimer = setTimeout(() => {
							child.kill("SIGKILL");
						}, 5_000);
					}, options.timeoutMs)
				: undefined;
		child.on("error", reject);
		child.on("close", (code) => {
			if (timer) {
				clearTimeout(timer);
			}
			if (killTimer) {
				clearTimeout(killTimer);
			}
			if (timedOut) {
				reject(new Error(`Command timed out after ${options.timeoutMs}ms`));
				return;
			}
			resolvePromise({
				stdout,
				stderr,
				exitCode: code ?? 0,
			});
		});

		if (options.input !== undefined) {
			child.stdin.write(options.input);
		}
		child.stdin.end();
	});
}

export function getNekoclawWorkerCommand(): string[] {
	return [
		"node",
		getContainerWorkerEntrypoint(),
		"__nekoclaw_internal",
		"worker",
		"run",
	];
}

export async function inspectContainerStatus(containerName: string): Promise<string> {
	const result = await runCommand("docker", ["inspect", "-f", "{{.State.Status}}", containerName]);
	if (result.exitCode !== 0) {
		if (result.stderr.includes("No such object")) {
			return "missing";
		}
		throw new Error(result.stderr.trim() || `docker inspect failed for ${containerName}`);
	}
	return result.stdout.trim() || "unknown";
}

export async function ensureAgentContainer(agent: AgentSpec, workspaceHostPath: string): Promise<string> {
	const status = await inspectContainerStatus(agent.containerName);
	if (status === "running") {
		return status;
	}
	if (status === "exited" || status === "created") {
		const startResult = await runCommand("docker", ["start", agent.containerName]);
		if (startResult.exitCode !== 0) {
			throw new Error(startResult.stderr.trim() || `Failed to start ${agent.containerName}`);
		}
		return "running";
	}

	const runtimeMountRoot = getRuntimeMountRoot();
	const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	const result = await runCommand("docker", [
		"run",
		"-d",
		"--name",
		agent.containerName,
		"--workdir",
		NEKOCLAW_CONTAINER_WORKSPACE_DIR,
		"-e",
		`TZ=${timezone}`,
		"-v",
		`${workspaceHostPath}:${NEKOCLAW_CONTAINER_WORKSPACE_DIR}`,
		"-v",
		`${runtimeMountRoot}:${NEKOCLAW_CONTAINER_CODE_DIR}:ro`,
		agent.image,
		"sh",
		"-lc",
		"while true; do sleep 3600; done",
	]);
	if (result.exitCode !== 0) {
		throw new Error(result.stderr.trim() || `Failed to create container ${agent.containerName}`);
	}
	return "running";
}

export async function stopAgentContainer(containerName: string): Promise<void> {
	const status = await inspectContainerStatus(containerName);
	if (status === "missing" || status === "exited") {
		return;
	}
	const result = await runCommand("docker", ["stop", containerName]);
	if (result.exitCode !== 0) {
		throw new Error(result.stderr.trim() || `Failed to stop ${containerName}`);
	}
}

export async function removeAgentContainer(containerName: string): Promise<void> {
	const status = await inspectContainerStatus(containerName);
	if (status === "missing") {
		return;
	}
	const result = await runCommand("docker", ["rm", "-f", containerName]);
	if (result.exitCode !== 0) {
		throw new Error(result.stderr.trim() || `Failed to remove ${containerName}`);
	}
}

export async function runWorkerInContainer(
	containerName: string,
	payload: string,
	env: Record<string, string | undefined>,
): Promise<string> {
	const envArgs = Object.entries(env).flatMap(([key, value]) => (value ? ["-e", `${key}=${value}`] : []));
	const result = await runCommand("docker", ["exec", "-i", ...envArgs, containerName, ...getNekoclawWorkerCommand()], {
		input: payload,
		timeoutMs: 300_000,
	});
	if (result.exitCode !== 0) {
		throw new Error(result.stderr.trim() || `Worker command failed in ${containerName}`);
	}
	return result.stdout;
}
