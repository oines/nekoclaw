import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentEnvHarnessContext } from "../src/internal/chat-harness/current-env.js";
import type { RunJob, WorkerResult } from "../src/types.js";

function extractText(job: RunJob): string {
	return job.event.blocks
		.filter((block): block is Extract<(typeof job.event.blocks)[number], { kind: "text" }> => block.kind === "text")
		.map((block) => block.text)
		.join("\n");
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function flushMicrotasks(times = 4): Promise<void> {
	for (let index = 0; index < times; index += 1) {
		await Promise.resolve();
	}
}

describe("internal chat harness", () => {
	let tempHome: string;
	const originalHome = process.env.HOME;

	beforeEach(() => {
		tempHome = mkdtempSync(join(tmpdir(), "nekoclaw-chat-harness-test-"));
		process.env.HOME = tempHome;
		vi.resetModules();
	});

	afterEach(() => {
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		rmSync(tempHome, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("runs representative harness scenarios with stubbed worker execution for telegram and napcat", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { runChatHarnessInCurrentEnvironment } = await import("../src/internal/chat-harness/current-env.js");

		const store = new JsonNekoclawStore();
		const agent = store.createAgent({ slug: "harness-cat" });
		store.setBuiltinModelConfig(agent.agentId, {
			provider: "openai",
			modelId: "gpt-5",
			apiKey: "test-key",
		});

		const memory = new Map<string, string>();
		const executeJob = async (job: RunJob, context: CurrentEnvHarnessContext): Promise<WorkerResult> => {
			const text = extractText(job);
			if (text.includes("Remember this codeword for later:")) {
				const match = text.match(/NEKO-ALPHA-\d+/);
				if (match) {
					memory.set(job.sessionRecordId, match[0]);
					return { outbound: { text: `remembered ${match[0]}` } };
				}
			}
			if (text.includes("What codeword did I ask you to remember?")) {
				return { outbound: { text: memory.get(job.sessionRecordId) ?? "UNKNOWN" } };
			}
			if (text.includes("Remember this codeword: RESET-ME-188")) {
				memory.set(job.sessionRecordId, "RESET-ME-188");
				return { outbound: { text: "remembered RESET-ME-188" } };
			}
			if (text.includes("Reply with exactly: HARNESS_OK")) {
				return { outbound: { text: "HARNESS_OK" } };
			}
			if (text.includes("say HARNESS_GROUP_OK")) {
				return { outbound: { text: "HARNESS_GROUP_OK" } };
			}
			if (text.includes("prime the thread")) {
				return { outbound: { text: "thread primed" } };
			}
			if (text.includes("reply path should work")) {
				return { outbound: { text: "reply works" } };
			}
			if (text.includes("Say paired")) {
				return { outbound: { text: "paired" } };
			}
			if (text.includes("Use proactive send_message to tell the group: HARNESS_TARGET_OK and then confirm here with HARNESS_DM_OK")) {
				const targetGroup = context.store
					.listSessions(job.agentId)
					.find((session) => session.channelType === job.event.channelType && session.chatKind === "group");
				expect(targetGroup).toBeDefined();
				return {
					outbound: { text: "HARNESS_DM_OK" },
					toolActions: [
						{
							kind: "send_targeted",
							target: `${job.event.channelType}:group:${targetGroup!.externalConversationId}`,
							payload: { text: "HARNESS_TARGET_OK" },
						},
					],
				};
			}
			if (text.includes("What is the dominant color in this image? Reply with exactly: RED")) {
				const imageBlock = job.event.blocks.find((block): block is Extract<(typeof job.event.blocks)[number], { kind: "image" }> => block.kind === "image");
				expect(imageBlock?.attachment?.relativePath).toBeTruthy();
				const imagePath = join(context.workspaceRoot, imageBlock!.attachment!.relativePath);
				expect(existsSync(imagePath)).toBe(true);
				expect(readFileSync(imagePath).byteLength).toBeGreaterThan(0);
				return { outbound: { text: "RED" } };
			}
			if (text.includes("You received two solid-color images in one message. Reply with exactly: RED,BLUE")) {
				const imageBlocks = job.event.blocks.filter((block): block is Extract<(typeof job.event.blocks)[number], { kind: "image" }> => block.kind === "image");
				expect(imageBlocks).toHaveLength(2);
				for (const block of imageBlocks) {
					expect(block.attachment?.relativePath).toBeTruthy();
					const imagePath = join(context.workspaceRoot, block.attachment!.relativePath);
					expect(existsSync(imagePath)).toBe(true);
					expect(readFileSync(imagePath).byteLength).toBeGreaterThan(0);
				}
				return { outbound: { text: "RED,BLUE" } };
			}
			if (text.includes("Describe the scene in one short English sentence. Mention TREE, HOUSE, and SUN only if they are actually visible.")) {
				const imageBlock = job.event.blocks.find((block): block is Extract<(typeof job.event.blocks)[number], { kind: "image" }> => block.kind === "image");
				expect(imageBlock?.attachment?.relativePath).toBeTruthy();
				const imagePath = join(context.workspaceRoot, imageBlock!.attachment!.relativePath);
				expect(existsSync(imagePath)).toBe(true);
				expect(readFileSync(imagePath).byteLength).toBeGreaterThan(100);
				return { outbound: { text: "A TREE stands near a HOUSE under the SUN." } };
			}
			if (text.includes("复述这张图片的内容。先直接说画面里有什么")) {
				const imageBlock = job.event.blocks.find((block): block is Extract<(typeof job.event.blocks)[number], { kind: "image" }> => block.kind === "image");
				expect(imageBlock?.attachment?.relativePath).toBeTruthy();
				const imagePath = join(context.workspaceRoot, imageBlock!.attachment!.relativePath);
				expect(existsSync(imagePath)).toBe(true);
				expect(readFileSync(imagePath).byteLength).toBeGreaterThan(100);
				return { outbound: { text: "画面里有一棵树、一栋房子和太阳。" } };
			}
			if (text.includes("Open the attached file and reply with the secret word only.")) {
				const fileBlock = job.event.blocks.find((block): block is Extract<(typeof job.event.blocks)[number], { kind: "file" }> => block.kind === "file");
				expect(fileBlock?.attachment?.relativePath).toBeTruthy();
				const filePath = join(context.workspaceRoot, fileBlock!.attachment!.relativePath);
				expect(readFileSync(filePath, "utf-8")).toBe("HARNESS_FILE_SECRET_731\n");
				const imageFixture = context.createWorkspaceFixture({
					relativePath: "generated/outbound-vision.png",
					bytes: Buffer.from([9, 8, 7]),
				});
				const fileFixture = context.createWorkspaceFixture({
					relativePath: "generated/outbound-note.txt",
					bytes: Buffer.from("outbound attachment\n", "utf-8"),
				});
				return {
					outbound: {
						text: "HARNESS_FILE_SECRET_731",
						attachments: [
							{ kind: "image", filePath: imageFixture.containerPath, name: "outbound-vision.png" },
							{ kind: "file", filePath: fileFixture.containerPath, name: "outbound-note.txt" },
						],
					},
				};
			}
			if (text.includes("Open both attached files and reply with both secrets in order separated by a comma only.")) {
				const fileBlocks = job.event.blocks.filter((block): block is Extract<(typeof job.event.blocks)[number], { kind: "file" }> => block.kind === "file");
				expect(fileBlocks).toHaveLength(2);
				const contents = fileBlocks.map((block) => readFileSync(join(context.workspaceRoot, block.attachment!.relativePath), "utf-8"));
				expect(contents).toEqual(["HARNESS_FILE_SECRET_731\n", "HARNESS_FILE_SECRET_992\n"]);
				return {
					outbound: {
						text: "HARNESS_FILE_SECRET_731,HARNESS_FILE_SECRET_992",
					},
				};
			}
			if (text.includes("This is a synthetic benchmark image. Read the exact uppercase text printed on the red octagonal road sign. Reply with the sign text only, preserving spaces, and do not add any extra words.")) {
				const imageBlock = job.event.blocks.find((block): block is Extract<(typeof job.event.blocks)[number], { kind: "image" }> => block.kind === "image");
				expect(imageBlock?.attachment?.relativePath).toBeTruthy();
				const imagePath = join(context.workspaceRoot, imageBlock!.attachment!.relativePath);
				expect(existsSync(imagePath)).toBe(true);
				expect(readFileSync(imagePath).byteLength).toBeGreaterThan(100);
				return { outbound: { text: "STOP" } };
			}
			return { outbound: { text: "stub response" } };
		};

		const report = await runChatHarnessInCurrentEnvironment({
			agentRef: agent.agentId,
			channel: "both",
			timeoutMs: 5_000,
			scenario: [
				"dm_pair_prompt",
				"admin_model_session_override",
				"group_reply_ignored_not_bot",
				"dm_image_vision",
				"dm_multi_image_vision",
				"dm_natural_image_description",
				"dm_natural_image_restate_cn",
				"dm_file_attachment",
				"dm_multi_file_attachment",
				"dm_image_text_mixed",
				"tool_proactive_send_message",
			],
			executeJob,
		});

		expect(report.ok).toBe(true);
		expect(report.results).toHaveLength(22);
		expect(report.results.every((result) => result.status === "passed")).toBe(true);
		expect(report.results.some((result) => result.channel === "telegram")).toBe(true);
		expect(report.results.some((result) => result.channel === "napcat")).toBe(true);
		for (const channel of ["telegram", "napcat"] as const) {
			const mediaResult = report.results.find((result) => result.channel === channel && result.name === "dm_file_attachment");
			expect(mediaResult?.evidence.transcript.some((entry) => entry.kind === "outbound" && entry.attachments?.some((attachment) => attachment.kind === "image"))).toBe(true);
			expect(mediaResult?.evidence.transcript.some((entry) => entry.kind === "outbound" && entry.attachments?.some((attachment) => attachment.kind === "file"))).toBe(true);
			const proactiveResult = report.results.find((result) => result.channel === channel && result.name === "tool_proactive_send_message");
			expect(proactiveResult?.evidence.transcript.some((entry) => entry.kind === "outbound" && entry.text?.includes("HARNESS_TARGET_OK"))).toBe(true);
		}
	}, 20_000);

	it("lets another session reply first when one session is blocked in the real telegram routing path", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { createTelegramChannelPlugin } = await import("../src/channels/telegram.js");
		const { FakeTelegramBot, createTelegramMessage } = await import("../src/internal/chat-harness/fake-transports.js");
		const { CommandRouterService } = await import("../src/runtime/command-router.js");
		const { JobQueueService } = await import("../src/runtime/job-queue.js");
		const { MessageRouterService } = await import("../src/runtime/message-router.js");
		const { OutboundDispatchService } = await import("../src/runtime/outbound-dispatch.js");
		const { getRuntimeKey } = await import("../src/runtime/runtime-key.js");
		const store = new JsonNekoclawStore();
		const agent = store.createAgent({ slug: "parallel-routing-cat" });
		store.createChannel(agent.agentId, "telegram");
		store.setChannelToken(agent.agentId, "telegram", "token");
		const channel = store.getChannel(agent.agentId, "telegram");
		const sessionA = store.createSession(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "1001",
			chatKind: "dm",
		});
		const sessionB = store.createSession(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "1002",
			chatKind: "dm",
		});

		const fakeBot = new FakeTelegramBot({ id: 9001, username: "mock_bot" });
		const plugin = createTelegramChannelPlugin(channel, "token", undefined, "all", { bot: fakeBot });
		const plugins = new Map([[getRuntimeKey(agent.agentId, channel.type), plugin]]);
		const outboundDispatch = new OutboundDispatchService(store, plugins);
		const queues = new Map<string, Map<string, RunJob[]>>();
		const activeRunsByAgent = new Map<string, Map<string, { sessionRecordId: string; jobId: string; startedAt: string }>>();
		const gates = new Map<string, ReturnType<typeof deferred<WorkerResult>>>();
		const starts: string[] = [];
		const jobQueue = new JobQueueService(store, queues, activeRunsByAgent, async (job) => {
			starts.push(job.sessionRecordId);
			const gate = deferred<WorkerResult>();
			gates.set(job.sessionRecordId, gate);
			const result = await gate.promise;
			const session = store.getSession(agent.agentId, job.sessionRecordId);
			if (result.outbound.text?.trim()) {
				await outboundDispatch.sendToSession(agent, session, job.event, result.outbound);
			}
			return result;
		});
		jobQueue.initialize();
		const commands = new CommandRouterService(store, (agentId) => jobQueue.getStatus(agentId));
		const messageRouter = new MessageRouterService(store, plugins, commands, (job) => jobQueue.enqueue(job));

		plugin.startPolling({
			onEvent: async (event) => {
				await messageRouter.handleInbound(agent.agentId, "telegram", event);
			},
			onError: (error) => {
				throw error;
			},
		});
		await flushMicrotasks();

		await fakeBot.emitInbound(
			createTelegramMessage({
				chatId: 1001,
				chatType: "private",
				messageId: 1,
				text: "session A blocked",
				from: { id: 101, first_name: "Alice" },
			}),
		);
		await fakeBot.emitInbound(
			createTelegramMessage({
				chatId: 1002,
				chatType: "private",
				messageId: 2,
				text: "session B can continue",
				from: { id: 202, first_name: "Bob" },
			}),
		);
		await flushMicrotasks(6);

		expect(starts).toEqual([sessionA.sessionRecordId, sessionB.sessionRecordId]);
		expect(jobQueue.getStatus(agent.agentId)).toMatchObject({
			runningSessions: 2,
			queued: 0,
		});

		gates.get(sessionB.sessionRecordId)?.resolve({ outbound: { text: "reply-from-b" } });
		await flushMicrotasks(8);

		let outbound = fakeBot.transcript.filter((entry) => entry.kind === "outbound");
		expect(outbound.map((entry) => ({ chatId: entry.chatId, text: entry.text }))).toContainEqual({
			chatId: "1002",
			text: "reply-from-b",
		});
		expect(outbound.some((entry) => entry.chatId === "1001" && entry.text === "reply-from-a")).toBe(false);

		gates.get(sessionA.sessionRecordId)?.resolve({ outbound: { text: "reply-from-a" } });
		await flushMicrotasks(8);

		outbound = fakeBot.transcript.filter((entry) => entry.kind === "outbound");
		expect(outbound.map((entry) => ({ chatId: entry.chatId, text: entry.text }))).toEqual([
			{ chatId: "1002", text: "reply-from-b" },
			{ chatId: "1001", text: "reply-from-a" },
		]);
		expect(jobQueue.getStatus(agent.agentId)).toMatchObject({
			runningSessions: 0,
			queued: 0,
			processing: false,
		});
	});

	it("silently stops only the current session in the real telegram routing path", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { createTelegramChannelPlugin } = await import("../src/channels/telegram.js");
		const { FakeTelegramBot, createTelegramMessage } = await import("../src/internal/chat-harness/fake-transports.js");
		const { CommandRouterService } = await import("../src/runtime/command-router.js");
		const { JobQueueService } = await import("../src/runtime/job-queue.js");
		const { MessageRouterService } = await import("../src/runtime/message-router.js");
		const { OutboundDispatchService } = await import("../src/runtime/outbound-dispatch.js");
		const { getRuntimeKey } = await import("../src/runtime/runtime-key.js");

		const store = new JsonNekoclawStore();
		const agent = store.createAgent({ slug: "stop-routing-cat" });
		store.createChannel(agent.agentId, "telegram");
		store.setChannelToken(agent.agentId, "telegram", "token");
		const channel = store.getChannel(agent.agentId, "telegram");
		const sessionA = store.createSession(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "1101",
			chatKind: "dm",
		});
		const sessionB = store.createSession(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "1102",
			chatKind: "dm",
		});

		const fakeBot = new FakeTelegramBot({ id: 9001, username: "mock_bot" });
		const plugin = createTelegramChannelPlugin(channel, "token", undefined, "all", { bot: fakeBot });
		const plugins = new Map([[getRuntimeKey(agent.agentId, channel.type), plugin]]);
		const outboundDispatch = new OutboundDispatchService(store, plugins);
		const queues = new Map<string, Map<string, RunJob[]>>();
		const activeRunsByAgent = new Map<string, Map<string, { sessionRecordId: string; jobId: string; startedAt: string }>>();
		const starts: string[] = [];
		const gates = new Map<string, ReturnType<typeof deferred<WorkerResult>>>();
		const jobQueue = new JobQueueService(store, queues, activeRunsByAgent, async (job, context) => {
			starts.push(job.sessionRecordId);
			const gate = deferred<WorkerResult>();
			gates.set(job.sessionRecordId, gate);
			context.signal?.addEventListener(
				"abort",
				() => {
					gate.reject(context.signal?.reason);
				},
				{ once: true },
			);
			const result = await gate.promise;
			const session = store.getSession(agent.agentId, job.sessionRecordId);
			if (result.outbound.text?.trim()) {
				await outboundDispatch.sendToSession(agent, session, job.event, result.outbound);
			}
			return result;
		});
		jobQueue.initialize();
		const commands = new CommandRouterService(store, (agentId) => jobQueue.getStatus(agentId), (agentId, sessionRecordId) =>
			jobQueue.stopSession(agentId, sessionRecordId),
		);
		const messageRouter = new MessageRouterService(store, plugins, commands, (job) => jobQueue.enqueue(job));

		plugin.startPolling({
			onEvent: async (event) => {
				await messageRouter.handleInbound(agent.agentId, "telegram", event);
			},
			onError: (error) => {
				throw error;
			},
		});
		await flushMicrotasks();

		await fakeBot.emitInbound(
			createTelegramMessage({
				chatId: 1101,
				chatType: "private",
				messageId: 1,
				text: "session A blocked",
				from: { id: 101, first_name: "Alice" },
			}),
		);
		await fakeBot.emitInbound(
			createTelegramMessage({
				chatId: 1101,
				chatType: "private",
				messageId: 2,
				text: "session A queued follow up",
				from: { id: 101, first_name: "Alice" },
			}),
		);
		await fakeBot.emitInbound(
			createTelegramMessage({
				chatId: 1102,
				chatType: "private",
				messageId: 3,
				text: "session B can continue",
				from: { id: 202, first_name: "Bob" },
			}),
		);
		await flushMicrotasks(8);

		expect(starts).toEqual([sessionA.sessionRecordId, sessionB.sessionRecordId]);
		expect(jobQueue.getStatus(agent.agentId)).toMatchObject({
			runningSessions: 2,
			queued: 1,
		});

		await fakeBot.emitInbound(
			createTelegramMessage({
				chatId: 1101,
				chatType: "private",
				messageId: 4,
				text: "/stop",
				from: { id: 101, first_name: "Alice" },
			}),
		);
		await flushMicrotasks(12);

		expect(jobQueue.getStatus(agent.agentId)).toMatchObject({
			runningSessions: 1,
			queued: 0,
		});
		expect(store.recoverPendingJobs(agent.agentId).map((job) => job.sessionRecordId)).toEqual([sessionB.sessionRecordId]);
		expect(fakeBot.transcript.filter((entry) => entry.kind === "outbound" && entry.chatId === "1101")).toEqual([]);

		gates.get(sessionB.sessionRecordId)?.resolve({ outbound: { text: "reply-from-b" } });
		await flushMicrotasks(8);

		expect(fakeBot.transcript.filter((entry) => entry.kind === "outbound").map((entry) => ({
			chatId: entry.chatId,
			text: entry.text,
		}))).toEqual([{ chatId: "1102", text: "reply-from-b" }]);
		expect(jobQueue.getStatus(agent.agentId)).toMatchObject({
			runningSessions: 0,
			queued: 0,
			processing: false,
		});
	});

	it("runs scheduled reminder harness scenarios for telegram and napcat across dm, group, and reset invalidation", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { runChatHarnessInCurrentEnvironment } = await import("../src/internal/chat-harness/current-env.js");

		const store = new JsonNekoclawStore();
		const agent = store.createAgent({ slug: "harness-cron-cat" });
		store.setBuiltinModelConfig(agent.agentId, {
			provider: "openai",
			modelId: "gpt-5",
			apiKey: "test-key",
		});

		const executeJob = async (job: RunJob): Promise<WorkerResult> => {
			const text = extractText(job);
			if (job.kind === "scheduled") {
				return {
					outbound: {
						text: job.event.chatKind === "group" ? "REMINDER_FIRED_GROUP" : "REMINDER_FIRED_DM",
					},
				};
			}
			if (text.includes("Create a one-time session reminder and confirm with exactly: CRON_CREATED_DM")) {
				const cronId = `cron-harness-dm-${job.event.channelType}`;
				return {
					outbound: { text: "CRON_CREATED_DM" },
					toolActions: [
						{
							kind: "cron_create",
							cronId,
							scheduleKind: "once",
							message: "DM reminder",
							timezone: "Asia/Shanghai",
							runAtLocal: "2099-01-01T07:00",
						},
					],
				};
			}
			if (text.includes("Create a daily session reminder and confirm with exactly: CRON_CREATED_GROUP")) {
				const cronId = `cron-harness-group-${job.event.channelType}`;
				return {
					outbound: { text: "CRON_CREATED_GROUP" },
					toolActions: [
						{
							kind: "cron_create",
							cronId,
							scheduleKind: "daily",
							message: "Group reminder",
							timezone: "Asia/Shanghai",
							hour: 7,
							minute: 0,
						},
					],
				};
			}
			if (text.includes("Create a reminder that should be invalidated by reset and confirm with exactly: CRON_CREATED_RESET")) {
				const cronId = `cron-harness-reset-${job.event.channelType}`;
				return {
					outbound: { text: "CRON_CREATED_RESET" },
					toolActions: [
						{
							kind: "cron_create",
							cronId,
							scheduleKind: "once",
							message: "Reset reminder",
							timezone: "Asia/Shanghai",
							runAtLocal: "2099-01-01T08:00",
						},
					],
				};
			}
			return { outbound: { text: "stub response" } };
		};

		const report = await runChatHarnessInCurrentEnvironment({
			agentRef: agent.agentId,
			channel: "both",
			timeoutMs: 5_000,
			scenario: [
				"scheduled_session_reminder_dm",
				"scheduled_session_reminder_group",
				"scheduled_reminder_reset_invalidates",
			],
			executeJob,
		});

		expect(report.ok).toBe(true);
		expect(report.results).toHaveLength(6);
		expect(report.results.every((result) => result.status === "passed")).toBe(true);
		expect(report.results.some((result) => result.channel === "telegram" && result.name === "scheduled_session_reminder_dm")).toBe(true);
		expect(report.results.some((result) => result.channel === "napcat" && result.name === "scheduled_session_reminder_group")).toBe(true);
	});
	});
