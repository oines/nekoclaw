import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const cliEntry = join(process.cwd(), "src/cli.ts");
const cliCwd = process.cwd();

async function runCli(args: string[], env?: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	try {
		const result = await execFileAsync(process.execPath, ["--import", "tsx", cliEntry, ...args], {
			cwd: cliCwd,
			env: { ...process.env, ...env },
		});
		return {
			stdout: result.stdout,
			stderr: result.stderr,
			exitCode: 0,
		};
	} catch (error) {
		const failure = error as { stdout?: string; stderr?: string; code?: number };
		return {
			stdout: failure.stdout ?? "",
			stderr: failure.stderr ?? "",
			exitCode: failure.code ?? 1,
		};
	}
}

describe("nekoclaw cli help", () => {
	it("shows product-oriented top-level help", async () => {
		const result = await runCli(["--help"]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("AI agents for real chats");
		expect(result.stdout).toContain("Recommended start:");
		expect(result.stdout).toContain("nekoclaw quickstart");
		expect(result.stdout).toContain("nekoclaw status");
		expect(result.stdout).toContain("nekoclaw start");
		expect(result.stdout).toContain("nekoclaw stop");
		expect(result.stdout).toContain("nekoclaw restart");
		expect(result.stdout).toContain("nekoclaw doctor cat-agent");
		expect(result.stderr).toBe("");
	});

	it("shows subgroup help instead of treating --help as an unknown action", async () => {
		const result = await runCli(["agent", "--help"]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Create, inspect, enable, disable, and remove agents.");
		expect(result.stdout).toContain("create");
		expect(result.stdout).toContain("enable");
		expect(result.stdout).not.toContain('Unknown agent action "--help"');
	});

	it("shows action-level help with options and examples", async () => {
		const result = await runCli(["model", "set", "--help"]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Set or switch the model for an agent.");
		expect(result.stdout).toContain("--provider <provider>");
		expect(result.stdout).toContain("--base-url <baseUrl>");
		expect(result.stdout).toContain("--provider-id <providerId>");
		expect(result.stdout).toContain("nekoclaw model set cat-agent --provider openai --model gpt-5 --api-key <key>");
	});

	it("does not short-circuit leaf commands to help output", async () => {
		const tempHome = mkdtempSync(join(tmpdir(), "nekoclaw-cli-help-"));
		try {
			const result = await runCli(
				[
					"quickstart",
					"--name",
					"cat-agent",
					"--provider",
					"openai",
					"--model",
					"gpt-5",
					"--api-key",
					"test-key",
					"--token",
					"bot-token",
				],
				{ HOME: tempHome },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain('Created agent workspace for "cat-agent"');
			expect(result.stdout).not.toContain("Usage: nekoclaw quickstart");
		} finally {
			rmSync(tempHome, { recursive: true, force: true });
		}
	});

	it("prints commander-style errors for unknown subcommands", async () => {
		const result = await runCli(["agent", "wat"]);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("error: unknown command 'wat'");
		expect(result.stderr).toContain("Usage: nekoclaw agent");
	});

	it("shows top-level status command help", async () => {
		const result = await runCli(["status", "--help"]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Show shared daemon status and an overall agent summary.");
		expect(result.stdout).toContain("nekoclaw status");
	});
});
