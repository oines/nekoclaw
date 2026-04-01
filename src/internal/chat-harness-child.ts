import { runChatHarnessInCurrentEnvironment, type InternalChatHarnessRunOptions } from "./chat-harness/current-env.js";

const PAYLOAD_ENV = "NEKOCLAW_INTERNAL_CHAT_HARNESS_PAYLOAD";

async function main(): Promise<void> {
	const raw = process.env[PAYLOAD_ENV];
	if (!raw) {
		throw new Error(`Missing ${PAYLOAD_ENV}`);
	}
	const payload = JSON.parse(raw) as InternalChatHarnessRunOptions;
	const report = await runChatHarnessInCurrentEnvironment(payload);
	process.stdout.write(JSON.stringify(report));
}

void main().catch((error) => {
	process.stderr.write(error instanceof Error ? error.stack || error.message : String(error));
	process.exitCode = 1;
});
