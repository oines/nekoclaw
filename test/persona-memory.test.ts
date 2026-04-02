import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboundMessageEvent } from "../src/types.js";

function createEvent(input: {
	channelType: "telegram" | "napcat";
	chatId: string;
	chatKind: "dm" | "group";
	messageId: string;
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
		sender: { externalId: input.senderId, displayName: input.senderName },
		blocks: [{ kind: "text", text: input.text }],
		occurredAt: input.occurredAt,
	};
}

async function waitForBackgroundWork(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 30));
}

describe("persona memory service", () => {
	let tempHome: string;
	const originalHome = process.env.HOME;

	beforeEach(() => {
		tempHome = mkdtempSync(join(tmpdir(), "nekoclaw-persona-memory-"));
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
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.doUnmock("@mariozechner/pi-ai");
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
		expect(context.indexMarkdown).toBe("");
		expect(context.selectedMemories).toEqual([]);
		const observationPath = store.getPersonaObservationPath(agent.slug, "telegram-group-1001");
		expect(readFileSync(observationPath, "utf-8")).toContain("群里刚才在聊什么？");
	});

	it("selects detailed markdown memories on demand without exposing raw persona files to the worker", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { PersonaMemoryService } = await import("../src/runtime/persona-memory.js");
		const { writeTextFile } = await import("../src/store/fs.js");

		const store = new JsonNekoclawStore();
		const agent = store.createAgent({ slug: "selector-cat" });
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
				"小王在做 GPU 租赁平台。",
				"我们之前讨论过数据库选型，后来他抱怨选错了要换。",
			].join("\n"),
		);
		writeTextFile(
			join(store.getPersonaScenesDir(agent.slug), "telegram-group-abc.md"),
			"技术吹水群最近在讨论数据库和项目架构。",
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

		expect(context.indexMarkdown).toContain("GPU 租赁平台");
		expect(context.selectedMemories.some((memoryDoc) => memoryDoc.path === "memory/people/telegram-111.md")).toBe(true);
		expect(context.selectedMemories.every((memoryDoc) => !memoryDoc.path.startsWith(".nekoclaw-persona/"))).toBe(true);
	});

	it("records selector success audits when the model returns valid JSON", async () => {
		vi.doMock("@mariozechner/pi-ai", async () => {
			const actual = await vi.importActual<typeof import("@mariozechner/pi-ai")>("@mariozechner/pi-ai");
			return {
				...actual,
				complete: vi.fn(async () => ({
					content: [
						{
							type: "text",
							text: JSON.stringify({
								paths: ["memory/people/telegram-111.md"],
								notes: "Picked one sender memory.",
							}),
						},
					],
				})),
			};
		});
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { PersonaMemoryService } = await import("../src/runtime/persona-memory.js");
		const { writeTextFile } = await import("../src/store/fs.js");

		const store = new JsonNekoclawStore();
		let agent = store.createAgent({ slug: "selector-audit-cat" });
		agent = store.setBuiltinModelConfig(agent.agentId, { provider: "openai", modelId: "gpt-5", apiKey: "test-key" });
		const session = store.createSession(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "111",
			chatKind: "dm",
		});
		writeTextFile(store.getPersonaIndexPath(agent.slug), "## 我认识的人\n- 小王：数据库项目 → memory/people/telegram-111.md");
		writeTextFile(join(store.getPersonaPeopleDir(agent.slug), "telegram-111.md"), "数据库项目和小王。");
		const personaMemory = new PersonaMemoryService(store);
		const event = createEvent({
			channelType: "telegram",
			chatId: "111",
			chatKind: "dm",
			messageId: "m-selector-success",
			senderId: "111",
			senderName: "小王",
			text: "数据库那个项目还记得吗",
			occurredAt: "2026-04-03T00:00:00.000Z",
		});

		const context = await personaMemory.buildPreparedContext(agent, session, event);
		const audits = store.getAuditEntries(agent.agentId);

		expect(context.selectedMemories.some((entry) => entry.path === "memory/people/telegram-111.md")).toBe(true);
		expect(audits.some((entry) => entry.kind === "persona.selector_started")).toBe(true);
		expect(
			audits.some(
				(entry) =>
					entry.kind === "persona.selector_completed" &&
					entry.details.sceneRef === "telegram-dm-111" &&
					entry.details.selectedCount === 1,
			),
		).toBe(true);
		expect(audits.some((entry) => entry.kind === "persona.selector_fallback_used")).toBe(false);
	});

	it("times out selector model calls after 20 seconds and falls back without blocking prepared context", async () => {
		vi.useFakeTimers();
		vi.doMock("@mariozechner/pi-ai", async () => {
			const actual = await vi.importActual<typeof import("@mariozechner/pi-ai")>("@mariozechner/pi-ai");
			return {
				...actual,
				complete: vi.fn(() => new Promise(() => undefined)),
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
		writeTextFile(store.getPersonaIndexPath(agent.slug), "## 我认识的人\n- 小王：数据库项目 → memory/people/telegram-111.md");
		writeTextFile(join(store.getPersonaPeopleDir(agent.slug), "telegram-111.md"), "小王之前聊过数据库项目。");
		const personaMemory = new PersonaMemoryService(store);
		const event = createEvent({
			channelType: "telegram",
			chatId: "111",
			chatKind: "dm",
			messageId: "m-selector-timeout",
			senderId: "111",
			senderName: "小王",
			text: "数据库那个项目还记得吗",
			occurredAt: "2026-04-03T00:00:00.000Z",
		});

		const contextPromise = personaMemory.buildPreparedContext(agent, session, event);
		await vi.advanceTimersByTimeAsync(20_100);
		const context = await contextPromise;
		const audits = store.getAuditEntries(agent.agentId);

		expect(context.selectedMemories.some((entry) => entry.path === "memory/people/telegram-111.md")).toBe(true);
		expect(audits.some((entry) => entry.kind === "persona.selector_timed_out")).toBe(true);
		expect(
			audits.some(
				(entry) =>
					entry.kind === "persona.selector_fallback_used" &&
					entry.details.reason === "timeout" &&
					entry.details.sceneRef === "telegram-dm-111",
			),
		).toBe(true);
	});

	it("records selector failure audits and falls back when the model output is not valid JSON", async () => {
		vi.doMock("@mariozechner/pi-ai", async () => {
			const actual = await vi.importActual<typeof import("@mariozechner/pi-ai")>("@mariozechner/pi-ai");
			return {
				...actual,
				complete: vi.fn(async () => ({
					content: [{ type: "text", text: "definitely not json" }],
				})),
			};
		});
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { PersonaMemoryService } = await import("../src/runtime/persona-memory.js");
		const { writeTextFile } = await import("../src/store/fs.js");

		const store = new JsonNekoclawStore();
		let agent = store.createAgent({ slug: "selector-invalid-json-cat" });
		agent = store.setBuiltinModelConfig(agent.agentId, { provider: "openai", modelId: "gpt-5", apiKey: "test-key" });
		const session = store.createSession(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "111",
			chatKind: "dm",
		});
		writeTextFile(store.getPersonaIndexPath(agent.slug), "## 我认识的人\n- 小王：数据库项目 → memory/people/telegram-111.md");
		writeTextFile(join(store.getPersonaPeopleDir(agent.slug), "telegram-111.md"), "小王之前聊过数据库项目。");
		const personaMemory = new PersonaMemoryService(store);
		const event = createEvent({
			channelType: "telegram",
			chatId: "111",
			chatKind: "dm",
			messageId: "m-selector-invalid-json",
			senderId: "111",
			senderName: "小王",
			text: "数据库那个项目还记得吗",
			occurredAt: "2026-04-03T00:00:00.000Z",
		});

		const context = await personaMemory.buildPreparedContext(agent, session, event);
		const audits = store.getAuditEntries(agent.agentId);

		expect(context.selectedMemories.some((entry) => entry.path === "memory/people/telegram-111.md")).toBe(true);
		expect(
			audits.some(
				(entry) =>
					entry.kind === "persona.selector_failed" &&
					entry.details.reason === "missing_json",
			),
		).toBe(true);
		expect(
			audits.some(
				(entry) =>
					entry.kind === "persona.selector_fallback_used" &&
					entry.details.reason === "missing_json",
			),
		).toBe(true);
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
			replyText: "记得，你之前说在做 GPU 租赁平台。",
			personaContext: context,
		});
		await waitForBackgroundWork();

		expect(readFileSync(store.getPersonaIndexPath(agent.slug), "utf-8")).toBe("");
		expect(readFileSync(store.getPersonaObservationPath(agent.slug, "telegram-dm-111"), "utf-8")).toContain("GPU 租赁平台");
		expect(() => readFileSync(join(store.getPersonaPeopleDir(agent.slug), "telegram-111.md"), "utf-8")).toThrow();
	});

	it("runs fallback formation asynchronously after 50 observations and consumes processed observations", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { PersonaMemoryService } = await import("../src/runtime/persona-memory.js");

		const store = new JsonNekoclawStore();
		const agent = store.createAgent({ slug: "formation-cat" });
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

		personaMemory.scheduleFormation({
			agent,
			session,
			event,
			replyText: "记得，你之前说在做 GPU 租赁平台。",
			personaContext: context,
		});
		await waitForBackgroundWork();

		expect(readFileSync(store.getPersonaIndexPath(agent.slug), "utf-8")).toContain("telegram-111.md");
		expect(readFileSync(join(store.getPersonaPeopleDir(agent.slug), "telegram-111.md"), "utf-8")).toContain("GPU 租赁平台");
		expect(readFileSync(join(store.getPersonaScenesDir(agent.slug), "telegram-dm-111.md"), "utf-8")).toContain("张三");
		expect(() => readFileSync(store.getPersonaObservationPath(agent.slug, "telegram-dm-111"), "utf-8")).toThrow();
	});

	it("sweeps leftover observation backlog once the oldest pending observation is over 30 minutes old", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { PersonaMemoryService } = await import("../src/runtime/persona-memory.js");

		const store = new JsonNekoclawStore();
		const agent = store.createAgent({ slug: "backlog-cat" });
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

		personaMemory.queueBacklogSweep(agent);
		await waitForBackgroundWork();

		expect(readFileSync(store.getPersonaIndexPath(agent.slug), "utf-8")).toContain("telegram-group-1001.md");
		expect(readFileSync(join(store.getPersonaScenesDir(agent.slug), "telegram-group-1001.md"), "utf-8")).toContain("招人");
		expect(() => readFileSync(store.getPersonaObservationPath(agent.slug, "telegram-group-1001"), "utf-8")).toThrow();
	});

	it("discards the same backlog after three failed formation attempts and starts accumulating fresh observations again", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { PersonaMemoryService } = await import("../src/runtime/persona-memory.js");
		const fs = await import("../src/store/fs.js");

		const store = new JsonNekoclawStore();
		const agent = store.createAgent({ slug: "discard-cat" });
		const session = store.createSession(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "-1001",
			chatKind: "group",
		});
		const personaMemory = new PersonaMemoryService(store);
		const actualWriteTextFile = fs.writeTextFile;
		vi.spyOn(fs, "writeTextFile").mockImplementation((path, value, options) => {
			if (path.includes(".nekoclaw-persona") && !path.includes("/control/formation-retries/")) {
				throw new Error("simulated persona write failure");
			}
			return actualWriteTextFile(path, value, options);
		});

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

		expect(() => readFileSync(store.getPersonaObservationPath(agent.slug, "telegram-group-1001"), "utf-8")).toThrow();
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
		vi.spyOn(Date, "now").mockReturnValue(new Date("2026-04-01T18:00:00.000Z").getTime());
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
			replyText: "好的",
			personaContext: { indexMarkdown: "", sceneObservations: "", selectedMemories: [], selectionNotes: "" },
		});
		personaMemory.queueDream(agent, { force: true });
		await waitForBackgroundWork();
		expect(timeline).toEqual(["formation:start"]);

		releaseFormation?.();
		await personaMemory.whenIdle(agent.agentId);
		expect(timeline).toEqual(["formation:start", "formation:end", "dream:start"]);
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
		vi.spyOn(personaMemory as any, "runDreamPlanner").mockResolvedValue({
			targets: [{ path: "memory/people/known.md", sources: [], reason: "refresh" }],
			notes: "rewrite one person",
		});
		vi.spyOn(personaMemory as any, "runDreamWriter").mockResolvedValue({
			indexMarkdown: "## 我认识的人\n- 已知人物：更新后 → memory/people/known.md",
			writes: [{ path: "memory/people/known.md", content: "更新后的 Dream 记忆。\n" }],
		});

		personaMemory.queueDream(agent, { force: true });
		await personaMemory.whenIdle(agent.agentId);

		expect(readFileSync(store.getPersonaIndexPath(agent.slug), "utf-8")).toContain("更新后");
		expect(readFileSync(join(store.getPersonaPeopleDir(agent.slug), "known.md"), "utf-8")).toContain("更新后的 Dream 记忆");
		expect(readFileSync(store.getPersonaObservationPath(agent.slug, "telegram-group-1001"), "utf-8")).toContain("这条 observation 应该继续保留");
		const audits = store.getAuditEntries(agent.agentId);
		expect(audits.some((entry) => entry.kind === "persona.dream_started")).toBe(true);
		expect(audits.some((entry) => entry.kind === "persona.dream_applied")).toBe(true);
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
		vi.spyOn(personaMemory as any, "runDreamPlanner").mockRejectedValue(new Error("planner boom"));

		personaMemory.queueDream(agent, { force: true });
		await personaMemory.whenIdle(agent.agentId);

		expect(readFileSync(join(store.getPersonaPeopleDir(agent.slug), "known.md"), "utf-8")).toContain("失败前的人物记忆");
		expect(readFileSync(store.getPersonaObservationPath(agent.slug, "telegram-group-1001"), "utf-8")).toContain("dream 失败时 observation 不该被消费");
		expect(store.getAuditEntries(agent.agentId).some((entry) => entry.kind === "persona.dream_failed")).toBe(true);
	});
	});
