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
});
