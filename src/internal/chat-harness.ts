import { mkdtempSync, rmSync, cpSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { NEKOCLAW_ROOT_DIR } from "../config.js";
import type { InternalChatHarnessReport, InternalChatHarnessRunOptions } from "./chat-harness/current-env.js";

const PAYLOAD_ENV = "NEKOCLAW_INTERNAL_CHAT_HARNESS_PAYLOAD";

interface ChildHarnessPayload extends InternalChatHarnessRunOptions {}

function getPackageRoot(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "../..");
}

function getChildEntrypoint(): string {
	return join(getPackageRoot(), "dist", "internal", "chat-harness-child.js");
}

function runChildHarness(home: string, payload: ChildHarnessPayload): Promise<InternalChatHarnessReport> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(process.execPath, [getChildEntrypoint()], {
			env: {
				...process.env,
				HOME: home,
				[PAYLOAD_ENV]: JSON.stringify(payload),
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) {
				reject(new Error(stderr.trim() || stdout.trim() || `chat harness child exited with ${code ?? 1}`));
				return;
			}
			try {
				resolvePromise(JSON.parse(stdout.trim()) as InternalChatHarnessReport);
			} catch (error) {
				reject(new Error(`Failed to parse chat harness child output: ${stdout}\n${stderr}\n${String(error)}`));
			}
		});
	});
}

function createSandboxHome(): { home: string; sandboxRoot: string } {
	const sandboxRoot = mkdtempSync(join(tmpdir(), "nekoclaw-chat-harness-"));
	const home = join(sandboxRoot, "home");
	const targetRoot = join(home, ".nekoclaw");
	cpSync(NEKOCLAW_ROOT_DIR, targetRoot, { recursive: true, force: true });
	return { home, sandboxRoot };
}

export async function runInternalChatHarness(options: InternalChatHarnessRunOptions): Promise<InternalChatHarnessReport & { sandboxPath?: string }> {
	if (!existsSync(NEKOCLAW_ROOT_DIR)) {
		throw new Error(`Missing Nekoclaw root directory at ${NEKOCLAW_ROOT_DIR}`);
	}
	const sandbox = createSandboxHome();
	try {
		const report = await runChildHarness(sandbox.home, options);
		if (options.keepSandbox || !report.ok) {
			return {
				...report,
				sandboxPath: sandbox.sandboxRoot,
			};
		}
		rmSync(sandbox.sandboxRoot, { recursive: true, force: true });
		return report;
	} catch (error) {
		return Promise.reject(
			new Error(
				`${error instanceof Error ? error.message : String(error)}\nSandbox preserved at ${sandbox.sandboxRoot}`,
			),
		);
	}
}
