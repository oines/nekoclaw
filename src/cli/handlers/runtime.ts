import { spawn } from "node:child_process";
import chalk from "chalk";
import { NEKOCLAW_NAME, NEKOCLAW_RUNTIME_PROCESS_STATE_PATH } from "../../config.js";
import { NekoclawDaemon } from "../../runtime/daemon.js";
import { runWorkerFromStdin } from "../../runtime/worker.js";
import { withFileLock } from "../../store/fs.js";
import { JsonNekoclawStore } from "../../store/json-store.js";
import type { AgentSpec } from "../../types.js";
import { isRuntimeAlive } from "./shared.js";

export function isRecoverableRuntimeError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	const code = "code" in error ? String((error as { code?: unknown }).code) : "";
	if (["ECONNRESET", "EPIPE", "ECONNREFUSED", "ETIMEDOUT"].includes(code)) {
		return true;
	}
	const text = [error.message ?? "", error.stack ?? ""].join("\n");
	return (
		text.includes("socket hang up") ||
		text.includes("WebSocket was closed") ||
		text.includes("Fatal! more info see") ||
		text.includes("NapCat connection lost")
	);
}

async function waitForRuntimeControlCompletion(
	store: JsonNekoclawStore,
	requestId: string,
	options?: { timeoutMs?: number; pollMs?: number },
): Promise<"completed" | "failed" | "timed_out"> {
	const timeoutMs = options?.timeoutMs ?? 2_000;
	const pollMs = options?.pollMs ?? 50;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const action = store.getRuntimeControlAction(requestId);
		if (!action) {
			return "timed_out";
		}
		if (action.status === "completed" || action.status === "failed") {
			return action.status;
		}
		await new Promise((resolve) => setTimeout(resolve, pollMs));
	}
	return "timed_out";
}

export async function requestBackgroundRuntimeRemoval(store: JsonNekoclawStore, agent: AgentSpec): Promise<boolean> {
	const runtime = store.getRuntimeProcessState();
	if (!isRuntimeAlive(runtime.pid)) {
		return false;
	}
	const request = store.createRuntimeControlAction({
		kind: "agent.remove_runtime",
		agent: {
			agentId: agent.agentId,
			slug: agent.slug,
			containerName: agent.containerName,
		},
	});
	try {
		process.kill(runtime.pid!, "SIGUSR1");
		const status = await waitForRuntimeControlCompletion(store, request.requestId);
		const completed = store.getRuntimeControlAction(request.requestId);
		if (status === "completed") {
			store.deleteRuntimeControlAction(request.requestId);
			return true;
		}
		if (status === "failed") {
			store.deleteRuntimeControlAction(request.requestId);
			throw new Error(completed?.error || `Runtime cleanup failed for ${agent.slug}`);
		}
		store.deleteRuntimeControlAction(request.requestId);
		throw new Error(`Timed out waiting for runtime cleanup for ${agent.slug}`);
	} catch (error) {
		store.deleteRuntimeControlAction(request.requestId);
		if (error instanceof Error && error.message.includes("kill ESRCH")) {
			return false;
		}
		throw error;
	}
}

export async function ensureRuntimeProcess(store: JsonNekoclawStore): Promise<void> {
	withFileLock(NEKOCLAW_RUNTIME_PROCESS_STATE_PATH, () => {
		const state = store.getRuntimeProcessState();
		if (isRuntimeAlive(state.pid)) {
			return;
		}
		const child = spawn(process.execPath, [...process.execArgv, process.argv[1], "__nekoclaw_internal", "runtime"], {
			cwd: process.cwd(),
			detached: true,
			stdio: "ignore",
			env: process.env,
		});
		child.unref();
		store.writeRuntimeProcessState(
			{
				pid: child.pid,
				updatedAt: new Date().toISOString(),
			},
			{ skipLock: true },
		);
	});
}

export async function waitForRuntimeExit(pid: number, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isRuntimeAlive(pid)) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	if (isRuntimeAlive(pid)) {
		process.kill(pid, "SIGKILL");
	}
}

export async function handleRuntimeStart(store: JsonNekoclawStore): Promise<void> {
	const state = store.getRuntimeProcessState();
	if (isRuntimeAlive(state.pid)) {
		console.log(chalk.yellow(`${NEKOCLAW_NAME} runtime is already running`));
		console.log(`PID: ${state.pid ?? "-"}`);
		return;
	}
	await ensureRuntimeProcess(store);
	const next = store.getRuntimeProcessState();
	console.log(chalk.green(`${NEKOCLAW_NAME} runtime started`));
	console.log(`PID: ${next.pid ?? "-"}`);
}

export async function handleRuntimeStop(store: JsonNekoclawStore): Promise<void> {
	const state = store.getRuntimeProcessState();
	if (!isRuntimeAlive(state.pid)) {
		store.writeRuntimeProcessState({ updatedAt: new Date().toISOString() });
		console.log(chalk.yellow(`${NEKOCLAW_NAME} runtime is already stopped`));
		return;
	}
	process.kill(state.pid!, "SIGTERM");
	await waitForRuntimeExit(state.pid!);
	store.writeRuntimeProcessState({ updatedAt: new Date().toISOString() });
	console.log(chalk.green(`${NEKOCLAW_NAME} runtime stopped`));
}

export async function handleRuntimeRestart(store: JsonNekoclawStore): Promise<void> {
	await handleRuntimeStop(store);
	await handleRuntimeStart(store);
	const next = store.getRuntimeProcessState();
	console.log(chalk.green(`${NEKOCLAW_NAME} runtime restarted`));
	console.log(`PID: ${next.pid ?? "-"}`);
}

export async function runInternalRuntime(store: JsonNekoclawStore): Promise<void> {
	const daemon = new NekoclawDaemon(store);
	let exiting = false;
	const clearRuntimeProcessState = () => {
		store.writeRuntimeProcessState({ updatedAt: new Date().toISOString() });
	};
	const refreshRuntimeProcessState = () => {
		store.writeRuntimeProcessState({
			pid: process.pid,
			updatedAt: new Date().toISOString(),
		});
	};
	const fatalExit = (error: unknown) => {
		if (exiting) {
			return;
		}
		exiting = true;
		console.error(`nekoclaw runtime fatal error: ${error instanceof Error ? error.stack || error.message : String(error)}`);
		clearRuntimeProcessState();
		process.exit(1);
	};
	process.on("uncaughtException", (error) => {
		if (isRecoverableRuntimeError(error)) {
			console.error(`nekoclaw runtime recovered from channel error: ${error.stack || error.message}`);
			refreshRuntimeProcessState();
			return;
		}
		fatalExit(error);
	});
	process.on("unhandledRejection", (reason) => {
		console.error(`nekoclaw runtime unhandled rejection: ${reason instanceof Error ? reason.stack || reason.message : String(reason)}`);
		refreshRuntimeProcessState();
	});
	refreshRuntimeProcessState();
	await daemon.start();
	const shutdown = async () => {
		if (exiting) {
			return;
		}
		exiting = true;
		await daemon.stop();
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
	process.on("SIGUSR1", () => void daemon.processRuntimeControlActions());
	await new Promise(() => undefined);
}

export async function runInternalWorker(): Promise<void> {
	await runWorkerFromStdin();
}
