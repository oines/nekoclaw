import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboundMessageEvent } from "../src/types.js";

function createEvent(input: {
	channelType: "telegram" | "napcat";
	chatId: string;
	chatKind: "dm" | "group";
	messageId: string;
	replyToMessageId?: string;
	senderId: string;
	senderName: string;
	text: string;
	occurredAt: string;
	chatTitle?: string;
}): InboundMessageEvent {
	return {
		eventType: "message.created",
		channelType: input.channelType,
		chatId: input.chatId,
		chatKind: input.chatKind,
		chatTitle: input.chatTitle,
		messageId: input.messageId,
		replyToMessageId: input.replyToMessageId,
		sender: { externalId: input.senderId, displayName: input.senderName },
		blocks: [{ kind: "text", text: input.text }],
		occurredAt: input.occurredAt,
	};
}

async function waitForBackgroundWork(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 30));
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("persona memory service", () => {
	let tempHome: string;
	const originalHome = process.env.HOME;
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		tempHome = mkdtempSync(join(tmpdir(), "nekoclaw-persona-memory-"));
		process.env.HOME = tempHome;
		vi.resetModules();
		fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith("/responses/input_tokens")) {
				const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string };
				return new Response(
					JSON.stringify({
						object: "response.input_tokens",
						input_tokens: typeof body.input === "string" ? body.input.length : 0,
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			if (url.endsWith("/v1/messages/count_tokens")) {
				const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ content?: string }> };
				const text = body.messages?.[0]?.content ?? "";
				return new Response(JSON.stringify({ input_tokens: text.length }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response("not found", { status: 404 });
		});
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		rmSync(tempHome, { recursive: true, force: true });
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.doUnmock("@mariozechner/pi-ai");
	});

	it("uses a ten minute maintenance timeout", async () => {
		const { MAINTENANCE_TIMEOUT_MS } = await import("../src/runtime/persona-memory/constants.js");

		expect(MAINTENANCE_TIMEOUT_MS).toBe(600_000);
	});

	it("appends scene observations and exposes the latest scene window in prepared context", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { PersonaMemoryService } = await import("../src/runtime/persona-memory.js");

		const store = new JsonNekoclawStore();
		const agent = store.createAgent({ slug: "observer-cat" });
		const session = store.createSession(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "-1001",
			chatKind: "group",
		});
		const personaMemory = new PersonaMemoryService(store);

		personaMemory.recordInbound(
			agent.agentId,
			session,
			createEvent({
				channelType: "telegram",
				chatId: "-1001",
				chatKind: "group",
				messageId: "1",
				senderId: "101",
				senderName: "用户A",
				text: "支付接口又挂了",
				occurredAt: "2026-04-01T00:00:00.000Z",
				chatTitle: "支付群",
			}),
		);
		personaMemory.recordInbound(
			agent.agentId,
			session,
			createEvent({
				channelType: "telegram",
				chatId: "-1001",
				chatKind: "group",
				messageId: "2",
				senderId: "102",
				senderName: "用户B",
				text: "我看看日志，应该是超时",
				occurredAt: "2026-04-01T00:02:00.000Z",
				chatTitle: "支付群",
			}),
		);

		const question = createEvent({
			channelType: "telegram",
			chatId: "-1001",
			chatKind: "group",
			messageId: "3",
			senderId: "103",
			senderName: "用户C",
			text: "群里刚才在聊什么？",
			occurredAt: "2026-04-01T00:10:00.000Z",
			chatTitle: "支付群",
		});
		personaMemory.recordInbound(agent.agentId, session, question);

		const context = await personaMemory.buildPreparedContext(agent, session, question);

		expect(context.sceneObservations).toContain("支付接口又挂了");
		expect(context.sceneObservations).toContain("我看看日志，应该是超时");
		expect(context.sceneObservations).toContain("scene=支付群");
		expect(context.indexMarkdown).toBe("");
		expect(context.selectedMemoryMarkdowns).toEqual([]);
		const observationPath = store.getPersonaObservationPath(agent.slug, "telegram-group-1001");
		expect(readFileSync(observationPath, "utf-8")).toContain("scene=支付群");
		expect(readFileSync(observationPath, "utf-8")).toContain("群里刚才在聊什么？");
	});

	it("includes reply target context in observations when replying to another user", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { PersonaMemoryService } = await import("../src/runtime/persona-memory.js");
		const { buildInboundSessionLogEntry } = await import("../src/runtime/session-log.js");

		const store = new JsonNekoclawStore();
		const agent = store.createAgent({ slug: "reply-observer-cat" });
		const session = store.createSession(agent.agentId, {
			channelType: "napcat",
			externalConversationId: "1063820039",
			chatKind: "group",
		});
		const personaMemory = new PersonaMemoryService(store);
		store.appendSessionLog(
			agent.agentId,
			session.sessionRecordId,
			buildInboundSessionLogEntry(
				createEvent({
					channelType: "napcat",
					chatId: "1063820039",
					chatKind: "group",
					messageId: "100",
					senderId: "200",
					senderName: "B",
					text: "数据库先别动",
					occurredAt: "2026-04-01T00:00:00.000Z",
					chatTitle: "技术群",
				}),
			),
		);

		personaMemory.recordInbound(
			agent.agentId,
			session,
			createEvent({
				channelType: "napcat",
				chatId: "1063820039",
				chatKind: "group",
				messageId: "101",
				replyToMessageId: "100",
				senderId: "123",
				senderName: "A",
				text: "不行，支付已经炸了",
				occurredAt: "2026-04-01T00:01:00.000Z",
				chatTitle: "技术群",
			}),
		);

		const observationPath = store.getPersonaObservationPath(agent.slug, "napcat-group-1063820039");
		const observation = readFileSync(observationPath, "utf-8");
		expect(observation).toContain("[2026-04-01T00:01:00.000Z] qq:123 A | scene=技术群 reply_to B: Text: 数据库先别动");
		expect(observation).toContain("A: Text: 不行，支付已经炸了");
	});

	it("includes reply target context in observations when replying to a bot message", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { PersonaMemoryService } = await import("../src/runtime/persona-memory.js");
		const { buildBotOutboundSessionLogEntry } = await import("../src/runtime/session-log.js");

		const store = new JsonNekoclawStore();
		const agent = store.createAgent({ slug: "reply-bot-observer-cat" });
		const session = store.createSession(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "888",
			chatKind: "dm",
		});
		const personaMemory = new PersonaMemoryService(store);
		store.appendSessionLog(
			agent.agentId,
			session.sessionRecordId,
			buildBotOutboundSessionLogEntry({
				timestamp: "2026-04-01T00:00:00.000Z",
				session: {
					sessionRecordId: session.sessionRecordId,
					channelType: "telegram",
					externalConversationId: "888",
					chatKind: "dm",
				},
				payload: { text: "我先不重启，等你确认" },
				source: "outbound",
				messageIds: ["bot-1"],
			}),
		);

		personaMemory.recordInbound(
			agent.agentId,
			session,
			createEvent({
				channelType: "telegram",
				chatId: "888",
				chatKind: "dm",
				messageId: "102",
				replyToMessageId: "bot-1",
				senderId: "123",
				senderName: "A",
				text: "那你现在总结一下",
				occurredAt: "2026-04-01T00:01:00.000Z",
			}),
		);

		const observationPath = store.getPersonaObservationPath(agent.slug, "telegram-dm-888");
		const observation = readFileSync(observationPath, "utf-8");
		expect(observation).toContain("[2026-04-01T00:01:00.000Z] telegram:123 A reply_to Bot: Text: 我先不重启，等你确认");
		expect(observation).toContain("A: Text: 那你现在总结一下");
	});

	it("calls the selector with only sender, message, and manifest, then preloads the selected memory files", async () => {
		const completeMock = vi.fn(async () => ({
			content: [
				{
					type: "text" as const,
					text: JSON.stringify({
						paths: ["memory/people/telegram-111.md", "memory/scenes/telegram-group-abc.md"],
					}),
				},
			],
		}));
		vi.doMock("@mariozechner/pi-ai", async () => {
			const actual = await vi.importActual<typeof import("@mariozechner/pi-ai")>("@mariozechner/pi-ai");
			return {
				...actual,
				complete: completeMock,
			};
		});
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { PersonaMemoryService } = await import("../src/runtime/persona-memory.js");
		const { writeTextFile } = await import("../src/store/fs.js");

		const store = new JsonNekoclawStore();
		let agent = store.createAgent({ slug: "selector-cat" });
		agent = store.setBuiltinModelConfig(agent.agentId, { provider: "openai", modelId: "gpt-5", apiKey: "test-key" });
		const session = store.createSession(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "111",
			chatKind: "dm",
		});
		const personaMemory = new PersonaMemoryService(store);

		writeTextFile(
			store.getPersonaIndexPath(agent.slug),
			[
				"## 我认识的人",
				"- 小王(tg:111)：做 GPU 租赁平台，数据库选型后来证明选错了 → memory/people/telegram-111.md",
			].join("\n"),
		);
		writeTextFile(
			join(store.getPersonaPeopleDir(agent.slug), "telegram-111.md"),
			[
				"---",
				"title: 小王",
				"description: GPU 租赁平台项目负责人，和 bot 讨论过错误的数据库选型。",
				"---",
				"",
				"小王在做 GPU 租赁平台。",
				"我们之前讨论过数据库选型，后来他抱怨选错了要换。",
			].join("\n"),
		);
		writeTextFile(
			join(store.getPersonaScenesDir(agent.slug), "telegram-group-abc.md"),
			[
				"---",
				"title: 技术吹水群",
				"description: 最近在讨论数据库和项目架构。",
				"---",
				"",
				"技术吹水群最近在讨论数据库和项目架构。",
			].join("\n"),
		);
		personaMemory.recordInbound(
			agent.agentId,
			session,
			createEvent({
				channelType: "telegram",
				chatId: "111",
				chatKind: "dm",
				messageId: "obs-1",
				senderId: "111",
				senderName: "小王",
				text: "这是 observation 里的旧消息，不该喂给 selector",
				occurredAt: "2026-04-02T00:00:00.000Z",
			}),
		);

		const event = createEvent({
			channelType: "telegram",
			chatId: "111",
			chatKind: "dm",
			messageId: "m1",
			senderId: "111",
			senderName: "小王",
			text: "上次数据库选型那个事你还记得吗",
			occurredAt: "2026-04-03T00:00:00.000Z",
		});
		personaMemory.recordInbound(agent.agentId, session, event);

		const context = await personaMemory.buildPreparedContext(agent, session, event);
		const selectorContext = completeMock.mock.calls[0]?.[1];
		const selectorUserText =
			selectorContext?.messages?.[0] && typeof selectorContext.messages[0].content === "string"
				? selectorContext.messages[0].content
				: "";

		expect(context.indexMarkdown).toContain("GPU 租赁平台");
		expect(context.indexMarkdown).toContain("memory/people/telegram-111.md");
		expect(context.sceneObservations).toContain("上次数据库选型那个事你还记得吗");
		expect(context.selectedMemoryMarkdowns.map((entry) => entry.path)).toEqual([
			"memory/people/telegram-111.md",
			"memory/scenes/telegram-group-abc.md",
		]);
		expect(context.selectedMemoryMarkdowns[0]?.markdown).toContain("数据库选型");
		expect(context.selectedMemoryMarkdowns[1]?.markdown).toContain("技术吹水群最近在讨论数据库和项目架构");
		expect(selectorUserText).toContain("Current sender: telegram:111 (小王)");
		expect(selectorUserText).toContain("Message: 上次数据库选型那个事你还记得吗");
		expect(selectorUserText).toContain("Available memory files:");
		expect(selectorUserText).toContain("[people] memory/people/telegram-111.md");
		expect(selectorUserText).toContain("[scene] memory/scenes/telegram-group-abc.md");
		expect(selectorUserText).not.toContain("## 我认识的人");
		expect(selectorUserText).not.toContain("这是 observation 里的旧消息，不该喂给 selector");
		const audits = store.getAuditEntries(agent.agentId);
		expect(audits.some((entry) => entry.kind === "persona.selector_applied" && entry.details.selectedCount === 2)).toBe(true);
	});

	it("filters invalid selector paths and keeps only valid selected memory files", async () => {
		const completeMock = vi.fn(async () => ({
			content: [
				{
					type: "text" as const,
					text: JSON.stringify({
						paths: ["memory/people/telegram-111.md", "memory/people/not-found.md"],
					}),
				},
			],
		}));
		vi.doMock("@mariozechner/pi-ai", async () => {
			const actual = await vi.importActual<typeof import("@mariozechner/pi-ai")>("@mariozechner/pi-ai");
			return {
				...actual,
				complete: completeMock,
			};
		});
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { PersonaMemoryService } = await import("../src/runtime/persona-memory.js");
		const { writeTextFile } = await import("../src/store/fs.js");

		const store = new JsonNekoclawStore();
		let agent = store.createAgent({ slug: "selector-filter-cat" });
		agent = store.setBuiltinModelConfig(agent.agentId, { provider: "openai", modelId: "gpt-5", apiKey: "test-key" });
		const session = store.createSession(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "111",
			chatKind: "dm",
		});
		const personaMemory = new PersonaMemoryService(store);
		writeTextFile(
			join(store.getPersonaPeopleDir(agent.slug), "telegram-111.md"),
			[
				"---",
				"title: 小王",
				"description: GPU 租赁平台项目负责人。",
				"---",
				"",
				"小王在做 GPU 租赁平台。",
			].join("\n"),
		);

		const event = createEvent({
			channelType: "telegram",
			chatId: "111",
			chatKind: "dm",
			messageId: "m-filter",
			senderId: "111",
			senderName: "小王",
			text: "我是谁",
			occurredAt: "2026-04-03T00:00:00.000Z",
		});

		const context = await personaMemory.buildPreparedContext(agent, session, event);

		expect(context.selectedMemoryMarkdowns.map((entry) => entry.path)).toEqual(["memory/people/telegram-111.md"]);
		expect(completeMock).toHaveBeenCalledTimes(1);
	});

	it("returns index and observations when selector times out, and records a timeout audit", async () => {
		vi.useFakeTimers();
		const completeMock = vi.fn(async () => await new Promise(() => undefined));
		vi.doMock("@mariozechner/pi-ai", async () => {
			const actual = await vi.importActual<typeof import("@mariozechner/pi-ai")>("@mariozechner/pi-ai");
			return {
				...actual,
				complete: completeMock,
			};
		});
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { PersonaMemoryService } = await import("../src/runtime/persona-memory.js");
		const { writeTextFile } = await import("../src/store/fs.js");

		const store = new JsonNekoclawStore();
		let agent = store.createAgent({ slug: "selector-timeout-cat" });
		agent = store.setBuiltinModelConfig(agent.agentId, { provider: "openai", modelId: "gpt-5", apiKey: "test-key" });
		const session = store.createSession(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "111",
			chatKind: "dm",
		});
		const personaMemory = new PersonaMemoryService(store);
		writeTextFile(store.getPersonaIndexPath(agent.slug), "## 我认识的人\n- 小王 → memory/people/telegram-111.md");
		writeTextFile(
			join(store.getPersonaPeopleDir(agent.slug), "telegram-111.md"),
			[
				"---",
				"title: 小王",
				"description: GPU 租赁平台项目负责人。",
				"---",
				"",
				"小王在做 GPU 租赁平台。",
			].join("\n"),
		);
		personaMemory.recordInbound(
			agent.agentId,
			session,
			createEvent({
				channelType: "telegram",
				chatId: "111",
				chatKind: "dm",
				messageId: "obs-timeout",
				senderId: "111",
				senderName: "小王",
				text: "之前我们聊过数据库",
				occurredAt: "2026-04-02T00:00:00.000Z",
			}),
		);
		const event = createEvent({
			channelType: "telegram",
			chatId: "111",
			chatKind: "dm",
			messageId: "m-timeout",
			senderId: "111",
			senderName: "小王",
			text: "上次那个事你还记得吗",
			occurredAt: "2026-04-03T00:00:00.000Z",
		});

		const contextPromise = personaMemory.buildPreparedContext(agent, session, event);
		await vi.advanceTimersByTimeAsync(5_100);
		const context = await contextPromise;

		expect(context.indexMarkdown).toContain("memory/people/telegram-111.md");
		expect(context.sceneObservations).toContain("之前我们聊过数据库");
		expect(context.selectedMemoryMarkdowns).toEqual([]);
		expect(store.getAuditEntries(agent.agentId).some((entry) => entry.kind === "persona.selector_timeout")).toBe(true);
	});

	it("returns index and observations when selector fails, and records a failure audit", async () => {
		const completeMock = vi.fn(async () => {
			throw new Error("selector boom");
		});
		vi.doMock("@mariozechner/pi-ai", async () => {
			const actual = await vi.importActual<typeof import("@mariozechner/pi-ai")>("@mariozechner/pi-ai");
			return {
				...actual,
				complete: completeMock,
			};
		});
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { PersonaMemoryService } = await import("../src/runtime/persona-memory.js");
		const { writeTextFile } = await import("../src/store/fs.js");

		const store = new JsonNekoclawStore();
		let agent = store.createAgent({ slug: "selector-fail-cat" });
		agent = store.setBuiltinModelConfig(agent.agentId, { provider: "openai", modelId: "gpt-5", apiKey: "test-key" });
		const session = store.createSession(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "111",
			chatKind: "dm",
		});
		const personaMemory = new PersonaMemoryService(store);
		writeTextFile(store.getPersonaIndexPath(agent.slug), "## 我认识的人\n- 小王 → memory/people/telegram-111.md");
		writeTextFile(
			join(store.getPersonaPeopleDir(agent.slug), "telegram-111.md"),
			[
				"---",
				"title: 小王",
				"description: GPU 租赁平台项目负责人。",
				"---",
				"",
				"小王在做 GPU 租赁平台。",
			].join("\n"),
		);
		personaMemory.recordInbound(
			agent.agentId,
			session,
			createEvent({
				channelType: "telegram",
				chatId: "111",
				chatKind: "dm",
				messageId: "obs-fail",
				senderId: "111",
				senderName: "小王",
				text: "这是失败场景里的 observation",
				occurredAt: "2026-04-02T00:00:00.000Z",
			}),
		);
		const event = createEvent({
			channelType: "telegram",
			chatId: "111",
			chatKind: "dm",
			messageId: "m-fail",
			senderId: "111",
			senderName: "小王",
			text: "之前那个数据库选择怎么说来着",
			occurredAt: "2026-04-03T00:00:00.000Z",
		});

		const context = await personaMemory.buildPreparedContext(agent, session, event);

		expect(context.indexMarkdown).toContain("memory/people/telegram-111.md");
		expect(context.sceneObservations).toContain("这是失败场景里的 observation");
		expect(context.selectedMemoryMarkdowns).toEqual([]);
		expect(store.getAuditEntries(agent.agentId).some((entry) => entry.kind === "persona.selector_failed")).toBe(true);
	});

	it("consumes a queued selector prefetch without issuing a second selector request", async () => {
		const completeMock = vi.fn(async () => ({
			content: [
				{
					type: "text" as const,
					text: JSON.stringify({
						paths: ["memory/people/telegram-111.md"],
					}),
				},
			],
		}));
		vi.doMock("@mariozechner/pi-ai", async () => {
			const actual = await vi.importActual<typeof import("@mariozechner/pi-ai")>("@mariozechner/pi-ai");
			return {
				...actual,
				complete: completeMock,
			};
		});
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { PersonaMemoryService } = await import("../src/runtime/persona-memory.js");
		const { writeTextFile } = await import("../src/store/fs.js");

		const store = new JsonNekoclawStore();
		let agent = store.createAgent({ slug: "selector-prefetch-cat" });
		agent = store.setBuiltinModelConfig(agent.agentId, { provider: "openai", modelId: "gpt-5", apiKey: "test-key" });
		const session = store.createSession(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "111",
			chatKind: "dm",
		});
		const personaMemory = new PersonaMemoryService(store);
		writeTextFile(
			join(store.getPersonaPeopleDir(agent.slug), "telegram-111.md"),
			[
				"---",
				"title: 小王",
				"description: GPU 租赁平台项目负责人。",
				"---",
				"",
				"小王在做 GPU 租赁平台。",
			].join("\n"),
		);
		const event = createEvent({
			channelType: "telegram",
			chatId: "111",
			chatKind: "dm",
			messageId: "m-prefetch",
			senderId: "111",
			senderName: "小王",
			text: "我是谁",
			occurredAt: "2026-04-03T00:00:00.000Z",
		});

		personaMemory.startSelectorPrefetch(agent, session, { jobId: "job-prefetch", event });
		const context = await personaMemory.buildPreparedContext(agent, session, event, undefined, {
			prefetchJobId: "job-prefetch",
			allowPrefetchWait: true,
		});

		expect(context.selectedMemoryMarkdowns.map((entry) => entry.path)).toEqual(["memory/people/telegram-111.md"]);
		expect(completeMock).toHaveBeenCalledTimes(1);
		expect(
			store
				.getAuditEntries(agent.agentId)
				.some((entry) => entry.kind === "persona.selector_prefetch_consumed" && entry.details.selectedCount === 1),
		).toBe(true);
	});

	it("skips unfinished selector prefetches when waiting is disabled", async () => {
		const gate = deferred<{
			content: Array<{ type: "text"; text: string }>;
		}>();
		const completeMock = vi.fn(async () => await gate.promise);
		vi.doMock("@mariozechner/pi-ai", async () => {
			const actual = await vi.importActual<typeof import("@mariozechner/pi-ai")>("@mariozechner/pi-ai");
			return {
				...actual,
				complete: completeMock,
			};
		});
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { PersonaMemoryService } = await import("../src/runtime/persona-memory.js");
		const { writeTextFile } = await import("../src/store/fs.js");

		const store = new JsonNekoclawStore();
		let agent = store.createAgent({ slug: "selector-prefetch-skip-cat" });
		agent = store.setBuiltinModelConfig(agent.agentId, { provider: "openai", modelId: "gpt-5", apiKey: "test-key" });
		const session = store.createSession(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "111",
			chatKind: "dm",
		});
		const personaMemory = new PersonaMemoryService(store);
		writeTextFile(
			join(store.getPersonaPeopleDir(agent.slug), "telegram-111.md"),
			[
				"---",
				"title: 小王",
				"description: GPU 租赁平台项目负责人。",
				"---",
				"",
				"小王在做 GPU 租赁平台。",
			].join("\n"),
		);
		const event = createEvent({
			channelType: "telegram",
			chatId: "111",
			chatKind: "dm",
			messageId: "m-prefetch-skip",
			senderId: "111",
			senderName: "小王",
			text: "我是谁",
			occurredAt: "2026-04-03T00:00:00.000Z",
		});

		personaMemory.startSelectorPrefetch(agent, session, { jobId: "job-prefetch-skip", event });
		const context = await personaMemory.buildPreparedContext(agent, session, event, undefined, {
			prefetchJobId: "job-prefetch-skip",
			allowPrefetchWait: false,
		});

		expect(context.selectedMemoryMarkdowns).toEqual([]);
		expect(completeMock).toHaveBeenCalledTimes(1);
		gate.resolve({
			content: [{ type: "text", text: JSON.stringify({ paths: ["memory/people/telegram-111.md"] }) }],
		});
	});

	it("skips selector when the current message has no text content", async () => {
		const completeMock = vi.fn(async () => ({
			content: [{ type: "text" as const, text: "{\"paths\":[]}" }],
		}));
		vi.doMock("@mariozechner/pi-ai", async () => {
			const actual = await vi.importActual<typeof import("@mariozechner/pi-ai")>("@mariozechner/pi-ai");
			return {
				...actual,
				complete: completeMock,
			};
		});
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { PersonaMemoryService } = await import("../src/runtime/persona-memory.js");
		const { writeTextFile } = await import("../src/store/fs.js");

		const store = new JsonNekoclawStore();
		let agent = store.createAgent({ slug: "selector-empty-message-cat" });
		agent = store.setBuiltinModelConfig(agent.agentId, { provider: "openai", modelId: "gpt-5", apiKey: "test-key" });
		const session = store.createSession(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "111",
			chatKind: "dm",
		});
		const personaMemory = new PersonaMemoryService(store);
		writeTextFile(
			join(store.getPersonaPeopleDir(agent.slug), "telegram-111.md"),
			[
				"---",
				"title: 小王",
				"description: GPU 租赁平台项目负责人。",
				"---",
				"",
				"小王在做 GPU 租赁平台。",
			].join("\n"),
		);
		const event: InboundMessageEvent = {
			eventType: "message.created",
			channelType: "telegram",
			chatId: "111",
			chatKind: "dm",
			messageId: "m-empty",
			sender: { externalId: "111", displayName: "小王" },
			blocks: [],
			occurredAt: "2026-04-03T00:00:00.000Z",
		};

		const context = await personaMemory.buildPreparedContext(agent, session, event);

		expect(context.selectedMemoryMarkdowns).toEqual([]);
		expect(completeMock).not.toHaveBeenCalled();
	});

	it("scans persona memory manifest from frontmatter and legacy content, sorted by mtime", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { PersonaMemoryService } = await import("../src/runtime/persona-memory.js");

		const store = new JsonNekoclawStore();
		const agent = store.createAgent({ slug: "manifest-scan-cat" });
		const personaMemory = new PersonaMemoryService(store);
		const legacyPath = join(store.getPersonaScenesDir(agent.slug), "legacy-scene.md");
		const frontmatterPath = join(store.getPersonaPeopleDir(agent.slug), "alice.md");

		writeFileSync(
			frontmatterPath,
			[
				"---",
				"title: \"Alice\"",
				"description: \"Long-time friend who loves photography.\"",
				"---",
				"",
				"Alice likes photography.",
			].join("\n"),
		);
		writeFileSync(
			legacyPath,
			[
				"# TIAL Members",
				"",
				"- People casually chat about projects and day-to-day life.",
			].join("\n"),
		);
		utimesSync(legacyPath, new Date("2026-04-01T00:00:00.000Z"), new Date("2026-04-01T00:00:00.000Z"));
		utimesSync(frontmatterPath, new Date("2026-04-02T00:00:00.000Z"), new Date("2026-04-02T00:00:00.000Z"));

		const manifest = (personaMemory as any).scanPersonaMemoryManifest(agent.slug) as Array<{
			path: string;
			kind: string;
			title: string;
			description: string;
			mtimeMs: number;
		}>;

		expect(manifest).toHaveLength(2);
		expect(manifest[0]?.path).toBe("memory/people/alice.md");
		expect(manifest[0]?.title).toBe("Alice");
		expect(manifest[0]?.description).toContain("Long-time friend who loves photography.");
		expect(manifest[1]?.path).toBe("memory/scenes/legacy-scene.md");
		expect(manifest[1]?.title).toBe("TIAL Members");
		expect(manifest[1]?.description).toContain("People casually chat about projects");
	});

	it("formats persona memory manifest as maintenance-facing text lines", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { PersonaMemoryService } = await import("../src/runtime/persona-memory.js");

		const store = new JsonNekoclawStore();
		const agent = store.createAgent({ slug: "manifest-format-cat" });
		const personaMemory = new PersonaMemoryService(store);

		writeFileSync(
			join(store.getPersonaPeopleDir(agent.slug), "alice.md"),
			[
				"---",
				"title: \"Alice\"",
				"description: \"Long-time friend who loves photography.\"",
				"---",
				"",
				"Alice likes photography.",
			].join("\n"),
		);

		const snapshot = (personaMemory as any).buildDreamCorpusSnapshot(agent.slug) as { memoryManifestText: string };

		expect(snapshot.memoryManifestText).toContain("- [people] Alice | memory/people/alice.md (");
		expect(snapshot.memoryManifestText).toContain("Long-time friend who loves photography.");
	});

	it("derives manifest routing cues from natural markdown details like personality and scene vibe", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { PersonaMemoryService } = await import("../src/runtime/persona-memory.js");
		const { writeTextFile } = await import("../src/store/fs.js");

		const store = new JsonNekoclawStore();
		const agent = store.createAgent({ slug: "manifest-cue-cat" });
		const personaMemory = new PersonaMemoryService(store);

		writeTextFile(
			join(store.getPersonaPeopleDir(agent.slug), "xiao-wang.md"),
			[
				"---",
				"title: 小王",
				"description: 经常和 bot 聊项目进展。",
				"---",
				"",
				"## 说话方式",
				"",
				"小王爱吐槽，常说“笑死”和“离谱”。",
				"",
				"## 最近",
				"",
				"最近在赶毕业论文。",
			].join("\n"),
		);
		writeTextFile(
			join(store.getPersonaScenesDir(agent.slug), "group-a.md"),
			[
				"---",
				"title: 技术吹水群",
				"description: 一个朋友们常驻的群。",
				"---",
				"",
				"## 这个群",
				"",
				"平时常聊项目推进和数据库选型，氛围偏熟人吐槽。",
				"",
				"## 活跃人物",
				"",
				"小王和老李经常出现。",
			].join("\n"),
		);

		const snapshot = (personaMemory as any).buildDreamCorpusSnapshot(agent.slug) as { memoryManifestText: string };

		expect(snapshot.memoryManifestText).toContain("爱吐槽");
		expect(snapshot.memoryManifestText).toContain("毕业论文");
		expect(snapshot.memoryManifestText).toContain("氛围偏熟人吐槽");
		expect(snapshot.memoryManifestText).toContain("活跃人物");
	});

	it("caps persona memory manifest to the 200 most recent files", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { PersonaMemoryService } = await import("../src/runtime/persona-memory.js");

		const store = new JsonNekoclawStore();
		const agent = store.createAgent({ slug: "manifest-cap-cat" });
		const personaMemory = new PersonaMemoryService(store);
		for (let index = 0; index < 205; index += 1) {
			const path = join(store.getPersonaPeopleDir(agent.slug), `person-${String(index).padStart(3, "0")}.md`);
			writeFileSync(
				path,
				[
					"---",
					`title: \"Person ${index}\"`,
					`description: \"Person ${index} description.\"`,
					"---",
					"",
					`Person ${index}.`,
				].join("\n"),
			);
			const when = new Date(`2026-04-01T00:${String(index % 60).padStart(2, "0")}:00.000Z`);
			when.setUTCDate(1 + Math.floor(index / 60));
			utimesSync(path, when, when);
		}

		const manifest = (personaMemory as any).scanPersonaMemoryManifest(agent.slug) as Array<{ path: string }>;

		expect(manifest).toHaveLength(200);
		expect(manifest.some((entry) => entry.path === "memory/people/person-204.md")).toBe(true);
		expect(manifest.some((entry) => entry.path === "memory/people/person-000.md")).toBe(false);
	});

	it("keeps high-value personality and ongoing sections when trimming selected memories for worker context", async () => {
		const completeMock = vi.fn(async () => ({
			content: [{ type: "text" as const, text: JSON.stringify({ paths: ["memory/people/telegram-111.md"] }) }],
		}));
		vi.doMock("@mariozechner/pi-ai", async () => {
			const actual = await vi.importActual<typeof import("@mariozechner/pi-ai")>("@mariozechner/pi-ai");
			return {
				...actual,
				complete: completeMock,
			};
		});
		fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith("/responses/input_tokens")) {
				const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string };
				return new Response(
					JSON.stringify({
						object: "response.input_tokens",
						input_tokens: typeof body.input === "string" ? body.input.length : 0,
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			return new Response("not found", { status: 404 });
		});
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { PersonaMemoryService } = await import("../src/runtime/persona-memory.js");
		const { writeTextFile } = await import("../src/store/fs.js");

		const store = new JsonNekoclawStore();
		let agent = store.createAgent({ slug: "selected-priority-cat" });
		agent = store.setBuiltinModelConfig(agent.agentId, { provider: "openai", modelId: "gpt-5", apiKey: "test-key" });
		const session = store.createSession(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "111",
			chatKind: "dm",
		});
		const personaMemory = new PersonaMemoryService(store);
		writeTextFile(
			join(store.getPersonaPeopleDir(agent.slug), "telegram-111.md"),
			[
				"---",
				"title: 小王",
				"description: 项目负责人。",
				"---",
				"",
				"## 长篇背景",
				"",
				"这是一大段背景说明。".repeat(200),
				"",
				"## 说话方式",
				"",
				"小王爱吐槽，常说“笑死”和“离谱”。",
				"",
				"## 最近",
				"",
				"最近在赶毕业论文，还在纠结数据库切换。",
			].join("\n"),
		);
		const event = createEvent({
			channelType: "telegram",
			chatId: "111",
			chatKind: "dm",
			messageId: "m-priority",
			senderId: "111",
			senderName: "小王",
			text: "你还记得我平时怎么说话吗",
			occurredAt: "2026-04-03T00:00:00.000Z",
		});

		const context = await personaMemory.buildPreparedContext(agent, session, event);
		const markdown = context.selectedMemoryMarkdowns[0]?.markdown ?? "";

		expect(markdown).toContain("说话方式");
		expect(markdown).toContain("爱吐槽");
		expect(markdown).toContain("最近");
		expect(markdown).toContain("毕业论文");
		expect(markdown).not.toContain("这是一大段背景说明。这是一大段背景说明。这是一大段背景说明。这是一大段背景说明。");
	});

	it("builds dream corpus signatures from mtimes instead of full memory content", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { PersonaMemoryService } = await import("../src/runtime/persona-memory.js");

		const store = new JsonNekoclawStore();
		const agent = store.createAgent({ slug: "dream-signature-cat" });
		const personaMemory = new PersonaMemoryService(store);
		const memoryPath = join(store.getPersonaPeopleDir(agent.slug), "stable.md");
		const fixedTime = new Date("2026-04-01T00:00:00.000Z");

		writeFileSync(
			memoryPath,
			[
				"---",
				"title: \"Stable Person\"",
				"description: \"First version.\"",
				"---",
				"",
				"First body.",
			].join("\n"),
		);
		utimesSync(memoryPath, fixedTime, fixedTime);
		const first = (personaMemory as any).buildDreamCorpusSnapshot(agent.slug) as { corpusSignature: string };

		writeFileSync(
			memoryPath,
			[
				"---",
				"title: \"Stable Person\"",
				"description: \"Second version with different body text.\"",
				"---",
				"",
				"Completely different body.",
			].join("\n"),
		);
		utimesSync(memoryPath, fixedTime, fixedTime);
		const second = (personaMemory as any).buildDreamCorpusSnapshot(agent.slug) as { corpusSignature: string };

		expect(second.corpusSignature).toBe(first.corpusSignature);
	});

	it("does not run formation before 50 observations or 30 minutes have elapsed", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { PersonaMemoryService } = await import("../src/runtime/persona-memory.js");

		const store = new JsonNekoclawStore();
		const agent = store.createAgent({ slug: "gated-formation-cat" });
		const session = store.createSession(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "111",
			chatKind: "dm",
		});
		const personaMemory = new PersonaMemoryService(store);

		const event = createEvent({
			channelType: "telegram",
			chatId: "111",
			chatKind: "dm",
			messageId: "m1",
			senderId: "111",
			senderName: "张三",
			text: "我叫张三，在做一个 GPU 租赁平台",
			occurredAt: "2026-04-01T00:00:00.000Z",
		});
		personaMemory.recordInbound(agent.agentId, session, event);
		const context = await personaMemory.buildPreparedContext(agent, session, event);

		personaMemory.scheduleFormation({
			agent,
			session,
			event,
			recentTimeline: "[2026-04-01T00:00:00.000Z] User (telegram:999 | 张三):\n- Text: 我叫张三，在做一个 GPU 租赁平台\n\n[2026-04-01T00:00:01.000Z] Bot:\n- Text: 记得，你之前说在做 GPU 租赁平台。",
			personaContext: context,
		});
		await waitForBackgroundWork();

		expect(readFileSync(store.getPersonaIndexPath(agent.slug), "utf-8")).toBe("");
		expect(readFileSync(store.getPersonaObservationPath(agent.slug, "telegram-dm-111"), "utf-8")).toContain("GPU 租赁平台");
		expect(() => readFileSync(join(store.getPersonaPeopleDir(agent.slug), "telegram-111.md"), "utf-8")).toThrow();
	});

	it("runs tool-driven formation asynchronously after 50 observations and consumes processed observations", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { PersonaMemoryService } = await import("../src/runtime/persona-memory.js");

		const store = new JsonNekoclawStore();
		let agent = store.createAgent({ slug: "formation-cat" });
		agent = store.setBuiltinModelConfig(agent.agentId, { provider: "openai", modelId: "gpt-5", apiKey: "test-key" });
		const session = store.createSession(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "111",
			chatKind: "dm",
		});
		const personaMemory = new PersonaMemoryService(store);

		let event = createEvent({
			channelType: "telegram",
			chatId: "111",
			chatKind: "dm",
			messageId: "m1",
			senderId: "111",
			senderName: "张三",
			text: "我叫张三，在做一个 GPU 租赁平台",
			occurredAt: "2026-04-01T00:00:00.000Z",
		});
		personaMemory.recordInbound(agent.agentId, session, event);
		for (let index = 2; index <= 50; index += 1) {
			event = createEvent({
				channelType: "telegram",
				chatId: "111",
				chatKind: "dm",
				messageId: `m${index}`,
				senderId: "111",
				senderName: "张三",
				text: `补充说明 ${index}`,
				occurredAt: `2026-04-01T00:${String(index - 1).padStart(2, "0")}:00.000Z`,
			});
			personaMemory.recordInbound(agent.agentId, session, event);
		}
		const context = await personaMemory.buildPreparedContext(agent, session, event);
		let formationPrompt = "";
		vi.spyOn(personaMemory as any, "executeMaintenanceSession").mockImplementation(async (_agent: unknown, _effectiveModel: unknown, input: unknown) => {
			const maintenanceInput = input as { tempPersonaDir: string; prompt?: string };
			formationPrompt = maintenanceInput.prompt ?? "";
			writeFileSync(
				join(maintenanceInput.tempPersonaDir, "index.md"),
				"## 我认识的人和场景\n- 张三：GPU 租赁平台 → memory/people/telegram-111.md\n- telegram-dm-111：近期互动 → memory/scenes/telegram-dm-111.md\n",
			);
			writeFileSync(
				join(maintenanceInput.tempPersonaDir, "memory/people/telegram-111.md"),
				"# 张三\n\n张三在做一个 GPU 租赁平台。",
			);
			writeFileSync(
				join(maintenanceInput.tempPersonaDir, "memory/scenes/telegram-dm-111.md"),
				"这个场景里张三一直在聊 GPU 租赁平台。",
			);
			return {
				finalize: { consumeObservationLines: 50, summary: "updated person and scene" },
				touchedPaths: ["index.md", "memory/people/telegram-111.md", "memory/scenes/telegram-dm-111.md"],
				deletedPaths: [],
			};
		});

		personaMemory.scheduleFormation({
			agent,
			session,
			event,
			recentTimeline: "[2026-04-01T00:00:00.000Z] User (telegram:999 | 张三):\n- Text: 我叫张三，在做一个 GPU 租赁平台\n\n[2026-04-01T00:00:01.000Z] Bot:\n- Text: 记得，你之前说在做 GPU 租赁平台。",
			personaContext: context,
		});
		await waitForBackgroundWork();

		expect(readFileSync(store.getPersonaIndexPath(agent.slug), "utf-8")).toContain("telegram-111.md");
		expect(readFileSync(join(store.getPersonaPeopleDir(agent.slug), "telegram-111.md"), "utf-8")).toContain("GPU 租赁平台");
		expect(readFileSync(join(store.getPersonaPeopleDir(agent.slug), "telegram-111.md"), "utf-8")).toContain("title: \"张三\"");
		expect(readFileSync(join(store.getPersonaScenesDir(agent.slug), "telegram-dm-111.md"), "utf-8")).toContain("description:");
		expect(readFileSync(join(store.getPersonaScenesDir(agent.slug), "telegram-dm-111.md"), "utf-8")).toContain("张三");
		expect(formationPrompt).toContain("Memory files manifest:");
		expect(formationPrompt).toContain("Finalize protocol (strict):");
		expect(formationPrompt).toContain("If this run does not change any memory files, you must still call persona_finalize exactly once with consumeObservationLines=0.");
		expect(formationPrompt).toContain("After calling persona_finalize, stop immediately and do not use any more tools.");
		expect(() => readFileSync(store.getPersonaObservationPath(agent.slug, "telegram-dm-111"), "utf-8")).toThrow();
	});

	it("sweeps leftover observation backlog once the oldest pending observation is over 30 minutes old", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { PersonaMemoryService } = await import("../src/runtime/persona-memory.js");

		const store = new JsonNekoclawStore();
		let agent = store.createAgent({ slug: "backlog-cat" });
		agent = store.setBuiltinModelConfig(agent.agentId, { provider: "openai", modelId: "gpt-5", apiKey: "test-key" });
		const session = store.createSession(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "-1001",
			chatKind: "group",
		});
		const personaMemory = new PersonaMemoryService(store);

		personaMemory.recordInbound(
			agent.agentId,
			session,
			createEvent({
				channelType: "telegram",
				chatId: "-1001",
				chatKind: "group",
				messageId: "m1",
				senderId: "101",
				senderName: "用户A",
				text: "创业项目最近开始招人了",
				occurredAt: "2026-04-01T00:00:00.000Z",
			}),
		);
		vi.spyOn(Date, "now").mockReturnValue(new Date("2026-04-01T00:40:00.000Z").getTime());
		vi.spyOn(personaMemory as any, "executeMaintenanceSession").mockImplementation(async (_agent: unknown, _effectiveModel: unknown, input: unknown) => {
			const maintenanceInput = input as { tempPersonaDir: string; prompt?: string };
			writeFileSync(
				join(maintenanceInput.tempPersonaDir, "index.md"),
				"## 我在的群\n- telegram-group-1001：近期聊招人 → memory/scenes/telegram-group-1001.md\n",
			);
			writeFileSync(
				join(maintenanceInput.tempPersonaDir, "memory/scenes/telegram-group-1001.md"),
				"这个群最近有人提到项目开始招人。\n",
			);
			return {
				finalize: { consumeObservationLines: 1, summary: "rolled backlog into scene memory" },
				touchedPaths: ["index.md", "memory/scenes/telegram-group-1001.md"],
				deletedPaths: [],
			};
		});

		personaMemory.queueBacklogSweep(agent);
		await waitForBackgroundWork();

		expect(readFileSync(store.getPersonaIndexPath(agent.slug), "utf-8")).toContain("telegram-group-1001.md");
		expect(readFileSync(join(store.getPersonaScenesDir(agent.slug), "telegram-group-1001.md"), "utf-8")).toContain("招人");
		expect(() => readFileSync(store.getPersonaObservationPath(agent.slug, "telegram-group-1001"), "utf-8")).toThrow();
	});

	it("discards the same backlog after three failed formation attempts and starts accumulating fresh observations again", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { PersonaMemoryService } = await import("../src/runtime/persona-memory.js");

		const store = new JsonNekoclawStore();
		let agent = store.createAgent({ slug: "discard-cat" });
		agent = store.setBuiltinModelConfig(agent.agentId, { provider: "openai", modelId: "gpt-5", apiKey: "test-key" });
		const session = store.createSession(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "-1001",
			chatKind: "group",
		});
		const personaMemory = new PersonaMemoryService(store);
		vi.spyOn(personaMemory as any, "executeMaintenanceSession").mockRejectedValue(new Error("simulated maintenance failure"));

		for (let index = 1; index <= 50; index += 1) {
			personaMemory.recordInbound(
				agent.agentId,
				session,
				createEvent({
					channelType: "telegram",
					chatId: "-1001",
					chatKind: "group",
					messageId: `m${index}`,
					senderId: "101",
					senderName: "用户A",
					text: `失败批次消息 ${index}`,
					occurredAt: `2026-04-01T00:${String(index - 1).padStart(2, "0")}:00.000Z`,
				}),
			);
		}

		for (let attempt = 1; attempt <= 3; attempt += 1) {
			personaMemory.queueBacklogSweep(agent);
			await waitForBackgroundWork();
		}

		expect(existsSync(store.getPersonaObservationPath(agent.slug, "telegram-group-1001"))).toBe(false);
		const audits = store.getAuditEntries(agent.agentId);
		expect(audits.filter((entry) => entry.kind === "persona.formation_failed")).toHaveLength(3);
		expect(audits.some((entry) => entry.kind === "persona.formation_discarded")).toBe(true);

		personaMemory.recordInbound(
			agent.agentId,
			session,
			createEvent({
				channelType: "telegram",
				chatId: "-1001",
				chatKind: "group",
				messageId: "fresh-1",
				senderId: "101",
				senderName: "用户A",
				text: "新的积攒从这里开始",
				occurredAt: "2026-04-01T02:00:00.000Z",
			}),
		);
			expect(readFileSync(store.getPersonaObservationPath(agent.slug, "telegram-group-1001"), "utf-8")).toContain("新的积攒从这里开始");
		});

	it("queues dream only when it is due and the corpus changed since the last successful run", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { PersonaMemoryService } = await import("../src/runtime/persona-memory.js");
		const { writeJsonFile, writeTextFile } = await import("../src/store/fs.js");

		const store = new JsonNekoclawStore();
		let agent = store.createAgent({ slug: "dream-gating-cat" });
		agent = store.setBuiltinModelConfig(agent.agentId, { provider: "openai", modelId: "gpt-5", apiKey: "test-key" });
		const personaMemory = new PersonaMemoryService(store);
		writeTextFile(join(store.getPersonaPeopleDir(agent.slug), "known.md"), "已知人物。");
		const runDream = vi.spyOn(personaMemory as any, "runDream").mockResolvedValue(undefined);

		personaMemory.queueDream(agent);
		await personaMemory.whenIdle(agent.agentId);
		expect(runDream).toHaveBeenCalledTimes(1);

		runDream.mockClear();
		writeJsonFile(store.getPersonaDreamStatePath(agent.slug), {
			lastCompletedAt: "2026-04-01T12:00:00.000Z",
			lastCorpusSignature: "irrelevant",
		});
		vi.spyOn(Date, "now").mockReturnValue(new Date("2026-04-01T15:00:00.000Z").getTime());
		personaMemory.queueDream(agent);
		await waitForBackgroundWork();
		expect(runDream).not.toHaveBeenCalled();
		expect(store.getAuditEntries(agent.agentId).some((entry) => entry.kind === "persona.dream_skipped" && entry.details.reason === "not_due")).toBe(true);

		runDream.mockClear();
		vi.restoreAllMocks();
		const personaMemory2 = new PersonaMemoryService(store);
		const runDream2 = vi.spyOn(personaMemory2 as any, "runDream").mockResolvedValue(undefined);
		const signature = (personaMemory2 as any).buildDreamCorpusSnapshot(agent.slug).corpusSignature as string;
		writeJsonFile(store.getPersonaDreamStatePath(agent.slug), {
			lastCompletedAt: "2026-03-30T00:00:00.000Z",
			lastCorpusSignature: signature,
		});
		personaMemory2.queueDream(agent);
		await waitForBackgroundWork();
		expect(runDream2).not.toHaveBeenCalled();
		expect(store.getAuditEntries(agent.agentId).some((entry) => entry.kind === "persona.dream_skipped" && entry.details.reason === "no_corpus_change")).toBe(true);
	});

	it("serializes dream behind pending formation work on the shared maintenance queue", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { PersonaMemoryService } = await import("../src/runtime/persona-memory.js");
		const { writeTextFile } = await import("../src/store/fs.js");

		const store = new JsonNekoclawStore();
		let agent = store.createAgent({ slug: "dream-queue-cat" });
		agent = store.setBuiltinModelConfig(agent.agentId, { provider: "openai", modelId: "gpt-5", apiKey: "test-key" });
		const session = store.createSession(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "111",
			chatKind: "dm",
		});
		const personaMemory = new PersonaMemoryService(store);
		writeTextFile(join(store.getPersonaPeopleDir(agent.slug), "known.md"), "已知人物。");
		const event = createEvent({
			channelType: "telegram",
			chatId: "111",
			chatKind: "dm",
			messageId: "m1",
			senderId: "111",
			senderName: "张三",
			text: "测试共享队列",
			occurredAt: "2026-04-01T00:00:00.000Z",
		});
		const timeline: string[] = [];
		let releaseFormation: (() => void) | undefined;
		const formationDone = new Promise<void>((resolve) => {
			releaseFormation = resolve;
		});
		vi.spyOn(personaMemory as any, "runFormationForTurn").mockImplementation(async () => {
			timeline.push("formation:start");
			await formationDone;
			timeline.push("formation:end");
		});
		vi.spyOn(personaMemory as any, "runDream").mockImplementation(async () => {
			timeline.push("dream:start");
		});

		personaMemory.scheduleFormation({
			agent,
			session,
			event,
			recentTimeline: "[2026-04-01T00:00:00.000Z] User (telegram:999 | 用户):\n- Text: 测试共享队列\n\n[2026-04-01T00:00:01.000Z] Bot:\n- Text: 好的",
			personaContext: { indexMarkdown: "", selectedMemoryMarkdowns: [], sceneObservations: "" },
		});
		personaMemory.queueDream(agent, { force: true });
		await waitForBackgroundWork();
		expect(timeline).toEqual(["formation:start"]);

		releaseFormation?.();
		await personaMemory.whenIdle(agent.agentId);
		expect(timeline).toEqual(["formation:start", "formation:end", "dream:start"]);
	});

	it("returns dream trigger status for queued, already queued, and no-memory cases", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { PersonaMemoryService } = await import("../src/runtime/persona-memory.js");
		const { writeTextFile } = await import("../src/store/fs.js");

		const store = new JsonNekoclawStore();
		let agent = store.createAgent({ slug: "dream-status-cat" });
		agent = store.setBuiltinModelConfig(agent.agentId, { provider: "openai", modelId: "gpt-5", apiKey: "test-key" });
		const personaMemory = new PersonaMemoryService(store);

		expect(personaMemory.requestDream(agent, { force: true })).toBe("no_memory_files");

		writeTextFile(join(store.getPersonaPeopleDir(agent.slug), "known.md"), "已知人物。");
		const runDream = vi.spyOn(personaMemory as any, "runDream").mockImplementation(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});

		expect(personaMemory.requestDream(agent, { force: true })).toBe("queued");
		expect(personaMemory.requestDream(agent, { force: true })).toBe("already_queued");

		await personaMemory.whenIdle(agent.agentId);
		expect(runDream).toHaveBeenCalledTimes(1);
	});

	it("applies dream rewrites without consuming observations and records dream audits", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { PersonaMemoryService } = await import("../src/runtime/persona-memory.js");
		const { writeTextFile } = await import("../src/store/fs.js");

		const store = new JsonNekoclawStore();
		let agent = store.createAgent({ slug: "dream-apply-cat" });
		agent = store.setBuiltinModelConfig(agent.agentId, { provider: "openai", modelId: "gpt-5", apiKey: "test-key" });
		const session = store.createSession(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "-1001",
			chatKind: "group",
		});
		const personaMemory = new PersonaMemoryService(store);
		writeTextFile(join(store.getPersonaPeopleDir(agent.slug), "known.md"), "旧的人物记忆。");
		personaMemory.recordInbound(
			agent.agentId,
			session,
			createEvent({
				channelType: "telegram",
				chatId: "-1001",
				chatKind: "group",
				messageId: "1",
				senderId: "101",
				senderName: "群友",
				text: "这条 observation 应该继续保留",
				occurredAt: "2026-04-01T00:00:00.000Z",
			}),
		);
		let dreamPrompt = "";
		vi.spyOn(personaMemory as any, "executeMaintenanceSession").mockImplementation(async (_agent: unknown, _effectiveModel: unknown, input: unknown) => {
			const maintenanceInput = input as { tempPersonaDir: string; prompt?: string };
			dreamPrompt = maintenanceInput.prompt ?? "";
			writeFileSync(
				join(maintenanceInput.tempPersonaDir, "index.md"),
				"## 我认识的人\n- 已知人物：更新后 → memory/people/known.md\n",
			);
			writeFileSync(
				join(maintenanceInput.tempPersonaDir, "memory/people/known.md"),
				"更新后的 Dream 记忆。",
			);
			return {
				finalize: { consumeObservationLines: 0, summary: "dream refreshed one person" },
				touchedPaths: ["index.md", "memory/people/known.md"],
				deletedPaths: [],
			};
		});

		personaMemory.queueDream(agent, { force: true });
		await personaMemory.whenIdle(agent.agentId);

		expect(readFileSync(store.getPersonaIndexPath(agent.slug), "utf-8")).toContain("更新后");
		expect(readFileSync(join(store.getPersonaPeopleDir(agent.slug), "known.md"), "utf-8")).toContain("更新后的 Dream 记忆");
		expect(readFileSync(join(store.getPersonaPeopleDir(agent.slug), "known.md"), "utf-8")).toContain("description:");
		expect(readFileSync(store.getPersonaObservationPath(agent.slug, "telegram-group-1001"), "utf-8")).toContain("这条 observation 应该继续保留");
		expect(dreamPrompt).toContain("Memory files manifest:");
		expect(dreamPrompt).toContain("Remove index.md references to memory files that do not exist anymore.");
		expect(dreamPrompt).toContain("Merge duplicate index.md entries for the same person or scene into a single canonical entry.");
		expect(dreamPrompt).toContain("For stale people files, the rewritten file should be meaningfully shorter than before.");
		expect(dreamPrompt).toContain("Rewrite memory in concise natural Chinese Markdown");
		expect(dreamPrompt).toContain("stable personality, tone, speaking style, and recurring catchphrases");
		expect(dreamPrompt).toContain("what kind of group/scene it is");
		expect(dreamPrompt).toContain("Index entries should stay route-oriented");
		const audits = store.getAuditEntries(agent.agentId);
		expect(audits.some((entry) => entry.kind === "persona.dream_started")).toBe(true);
		expect(audits.some((entry) => entry.kind === "persona.dream_applied")).toBe(true);
	});

	it("lets dream delete low-value memory files while keeping observations untouched", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { PersonaMemoryService } = await import("../src/runtime/persona-memory.js");
		const { writeTextFile } = await import("../src/store/fs.js");

		const store = new JsonNekoclawStore();
		let agent = store.createAgent({ slug: "dream-delete-cat" });
		agent = store.setBuiltinModelConfig(agent.agentId, { provider: "openai", modelId: "gpt-5", apiKey: "test-key" });
		const session = store.createSession(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "-1001",
			chatKind: "group",
		});
		const personaMemory = new PersonaMemoryService(store);
		writeTextFile(store.getPersonaIndexPath(agent.slug), "## 我认识的人\n- 低价值人物 → memory/people/obsolete.md\n");
		writeTextFile(join(store.getPersonaPeopleDir(agent.slug), "obsolete.md"), "一个已经长期无关紧要的人物。\n");
		personaMemory.recordInbound(
			agent.agentId,
			session,
			createEvent({
				channelType: "telegram",
				chatId: "-1001",
				chatKind: "group",
				messageId: "1",
				senderId: "101",
				senderName: "群友",
				text: "Dream 删除人物时 observation 仍然要保留",
				occurredAt: "2026-04-01T00:00:00.000Z",
			}),
		);
		vi.spyOn(personaMemory as any, "executeMaintenanceSession").mockImplementation(async (_agent: unknown, _effectiveModel: unknown, input: unknown) => {
			const maintenanceInput = input as { tempPersonaDir: string; prompt?: string };
			writeFileSync(join(maintenanceInput.tempPersonaDir, "index.md"), "## 我认识的人\n");
			rmSync(join(maintenanceInput.tempPersonaDir, "memory/people/obsolete.md"));
			return {
				finalize: { consumeObservationLines: 0, summary: "forgot one obsolete person" },
				touchedPaths: ["index.md"],
				deletedPaths: ["memory/people/obsolete.md"],
			};
		});

		personaMemory.queueDream(agent, { force: true });
		await personaMemory.whenIdle(agent.agentId);

		expect(readFileSync(store.getPersonaIndexPath(agent.slug), "utf-8")).not.toContain("obsolete.md");
		expect(existsSync(join(store.getPersonaPeopleDir(agent.slug), "obsolete.md"))).toBe(false);
		expect(readFileSync(store.getPersonaObservationPath(agent.slug, "telegram-group-1001"), "utf-8")).toContain("Dream 删除人物时 observation 仍然要保留");
	});

	it("records dream failures without breaking existing persona files or consuming observations", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { PersonaMemoryService } = await import("../src/runtime/persona-memory.js");
		const { writeTextFile } = await import("../src/store/fs.js");

		const store = new JsonNekoclawStore();
		let agent = store.createAgent({ slug: "dream-fail-cat" });
		agent = store.setBuiltinModelConfig(agent.agentId, { provider: "openai", modelId: "gpt-5", apiKey: "test-key" });
		const session = store.createSession(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "-1001",
			chatKind: "group",
		});
		const personaMemory = new PersonaMemoryService(store);
		writeTextFile(join(store.getPersonaPeopleDir(agent.slug), "known.md"), "失败前的人物记忆。");
		personaMemory.recordInbound(
			agent.agentId,
			session,
			createEvent({
				channelType: "telegram",
				chatId: "-1001",
				chatKind: "group",
				messageId: "1",
				senderId: "101",
				senderName: "群友",
				text: "dream 失败时 observation 不该被消费",
				occurredAt: "2026-04-01T00:00:00.000Z",
			}),
		);
		vi.spyOn(personaMemory as any, "executeMaintenanceSession").mockRejectedValue(new Error("dream boom"));

		personaMemory.queueDream(agent, { force: true });
		await personaMemory.whenIdle(agent.agentId);

		expect(readFileSync(join(store.getPersonaPeopleDir(agent.slug), "known.md"), "utf-8")).toContain("失败前的人物记忆");
		expect(readFileSync(store.getPersonaObservationPath(agent.slug, "telegram-group-1001"), "utf-8")).toContain("dream 失败时 observation 不该被消费");
		expect(store.getAuditEntries(agent.agentId).some((entry) => entry.kind === "persona.dream_failed")).toBe(true);
	});

	it("writes qq instead of napcat in observation lines for napcat channel events", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { PersonaMemoryService } = await import("../src/runtime/persona-memory.js");

		const store = new JsonNekoclawStore();
		const agent = store.createAgent({ slug: "napcat-obs-cat" });
		const session = store.createSession(agent.agentId, {
			channelType: "napcat",
			externalConversationId: "88888",
			chatKind: "group",
		});
		const personaMemory = new PersonaMemoryService(store);

		personaMemory.recordInbound(
			agent.agentId,
			session,
			createEvent({
				channelType: "napcat",
				chatId: "88888",
				chatKind: "group",
				messageId: "1",
				senderId: "12345",
				senderName: "小明",
				text: "hello from qq",
				occurredAt: "2026-04-03T00:00:00.000Z",
			}),
		);

		const observationPath = store.getPersonaObservationPath(agent.slug, "napcat-group-88888");
		const content = readFileSync(observationPath, "utf-8");
		expect(content).toContain("qq:12345");
		expect(content).not.toContain("napcat:");
	});

	it("formation prompt includes the recent timeline and observation format hint", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { PersonaMemoryService } = await import("../src/runtime/persona-memory.js");

		const store = new JsonNekoclawStore();
		let agent = store.createAgent({ slug: "formation-prompt-cat" });
		agent = store.setBuiltinModelConfig(agent.agentId, { provider: "openai", modelId: "gpt-5", apiKey: "test-key" });
		const session = store.createSession(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "999",
			chatKind: "dm",
		});
		const personaMemory = new PersonaMemoryService(store);

		let event = createEvent({
			channelType: "telegram",
			chatId: "999",
			chatKind: "dm",
			messageId: "m1",
			senderId: "999",
			senderName: "用户",
			text: "UNIQUE_INBOUND_TEXT_XYZ",
			occurredAt: "2026-04-01T00:00:00.000Z",
		});
		personaMemory.recordInbound(agent.agentId, session, event);
		for (let index = 2; index <= 50; index += 1) {
			event = createEvent({
				channelType: "telegram",
				chatId: "999",
				chatKind: "dm",
				messageId: `m${index}`,
				senderId: "999",
				senderName: "用户",
				text: `msg ${index}`,
				occurredAt: `2026-04-01T00:${String(index - 1).padStart(2, "0")}:00.000Z`,
			});
			personaMemory.recordInbound(agent.agentId, session, event);
		}
		const context = await personaMemory.buildPreparedContext(agent, session, event);
		let capturedPrompt = "";
		vi.spyOn(personaMemory as any, "executeMaintenanceSession").mockImplementation(async (_agent: unknown, _effectiveModel: unknown, input: unknown) => {
			const maintenanceInput = input as { tempPersonaDir: string; prompt?: string };
			capturedPrompt = maintenanceInput.prompt ?? "";
			return { finalize: { consumeObservationLines: 50, summary: "ok" }, touchedPaths: [], deletedPaths: [] };
		});

		personaMemory.scheduleFormation({
			agent,
			session,
			event,
			recentTimeline: "[2026-04-01T00:00:00.000Z] User (telegram:999 | 用户):\n- Text: UNIQUE_INBOUND_TEXT_XYZ\n\n[2026-04-01T00:00:01.000Z] Bot:\n- Text: bot reply here\n\n[2026-04-01T00:00:02.000Z] Bot:\n- Text: second promise",
			personaContext: context,
		});
		await waitForBackgroundWork();

		expect(capturedPrompt).not.toContain("Current inbound message");
		expect(capturedPrompt).toContain("Task: inspect the temporary persona workspace and update memory for this scene.");
		expect(capturedPrompt).toContain("Scene context for this run:");
		expect(capturedPrompt).toContain("- Channel: telegram");
		expect(capturedPrompt).toContain("- Chat kind: dm");
		expect(capturedPrompt).toContain("- Chat id: 999");
		expect(capturedPrompt).toContain("- Current sender id: 999");
		expect(capturedPrompt).toContain("- Current sender display name: 用户");
		expect(capturedPrompt).toContain("This scene is a direct conversation with 用户.");
		expect(capturedPrompt).toContain("Observation line format:");
		expect(capturedPrompt).toContain("scene=Chat Title");
		expect(capturedPrompt).toContain("Recent visible timeline for this scene:");
		expect(capturedPrompt).toContain("UNIQUE_INBOUND_TEXT_XYZ");
		expect(capturedPrompt).toContain("bot reply here");
		expect(capturedPrompt).toContain("second promise");
		expect(capturedPrompt).toContain("Timeline semantics: User is the current triggering message");
		expect(capturedPrompt).toContain("Observed lines are evidence only");
		expect(capturedPrompt).toContain("Bot-visible commitments and obligations stated in Bot turns");
		expect(capturedPrompt).toContain("Long-term defaults and standing preferences");
		expect(capturedPrompt).toContain("User identity corrections and links");
		expect(capturedPrompt).toContain("Stable personality signals for active people");
		expect(capturedPrompt).toContain("what kind of group/scene this is");
		expect(capturedPrompt).toContain("Do not create or significantly expand a people file unless the person is active enough");
		expect(capturedPrompt).toContain("Scene memory should read like a useful long-term scene profile");
		expect(capturedPrompt).toContain("Write memory in concise natural Chinese Markdown");
		expect(capturedPrompt).toContain("Update index.md summaries so the worker can notice that a detailed file is worth opening later.");
		expect(capturedPrompt).toContain("Finalize protocol (strict):");
		expect(capturedPrompt).toContain("If this run does not change any memory files, you must still call persona_finalize exactly once with consumeObservationLines=0.");
		expect(capturedPrompt).toContain("De-prioritize or omit:");
		expect(capturedPrompt).not.toContain("Ensure every people/scenes file you touch has YAML frontmatter");
	});

	it("includes group title and current sender identity in the formation prompt for group scenes", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { PersonaMemoryService } = await import("../src/runtime/persona-memory.js");

		const store = new JsonNekoclawStore();
		let agent = store.createAgent({ slug: "formation-scene-name-cat" });
		agent = store.setBuiltinModelConfig(agent.agentId, { provider: "openai", modelId: "gpt-5", apiKey: "test-key" });
		const session = store.createSession(agent.agentId, {
			channelType: "napcat",
			externalConversationId: "1043518871",
			chatKind: "group",
			chatTitle: "运维总群",
		});
		const personaMemory = new PersonaMemoryService(store);

		let event = createEvent({
			channelType: "napcat",
			chatId: "1043518871",
			chatKind: "group",
			chatTitle: "运维总群",
			messageId: "group-1",
			senderId: "3184675714",
			senderName: "张三",
			text: "今晚先别重启，等我看监控",
			occurredAt: "2026-04-01T00:00:00.000Z",
		});
		personaMemory.recordInbound(agent.agentId, session, event);
		for (let index = 2; index <= 50; index += 1) {
			event = createEvent({
				channelType: "napcat",
				chatId: "1043518871",
				chatKind: "group",
				chatTitle: "运维总群",
				messageId: `group-${index}`,
				senderId: "3184675714",
				senderName: "张三",
				text: `运维群消息 ${index}`,
				occurredAt: `2026-04-01T00:${String(index - 1).padStart(2, "0")}:00.000Z`,
			});
			personaMemory.recordInbound(agent.agentId, session, event);
		}
		const context = await personaMemory.buildPreparedContext(agent, session, event);

		let capturedPrompt = "";
		vi.spyOn(personaMemory as any, "executeMaintenanceSession").mockImplementation(async (_agent: unknown, _effectiveModel: unknown, input: unknown) => {
			const maintenanceInput = input as { prompt?: string };
			capturedPrompt = maintenanceInput.prompt ?? "";
			return { finalize: { consumeObservationLines: 1, summary: "ok" }, touchedPaths: [], deletedPaths: [] };
		});

		personaMemory.scheduleFormation({
			agent,
			session,
			event,
			recentTimeline: "[2026-04-01T00:00:00.000Z] User (telegram:999 | 用户):\n- Text: 今晚先别重启，等我看监控\n\n[2026-04-01T00:00:01.000Z] Bot:\n- Text: 好，我先不动。",
			personaContext: context,
		});
		await waitForBackgroundWork();

		expect(capturedPrompt).toContain("Scene context for this run:");
		expect(capturedPrompt).toContain("- Channel: qq");
		expect(capturedPrompt).toContain("- Chat kind: group");
		expect(capturedPrompt).toContain("- Chat id: 1043518871");
		expect(capturedPrompt).toContain("- Chat title: 运维总群");
		expect(capturedPrompt).toContain("- Current sender id: 3184675714");
		expect(capturedPrompt).toContain("- Current sender display name: 张三");
		expect(capturedPrompt).not.toContain("This scene is a direct conversation with");
	});
	});
