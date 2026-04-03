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
		const observationPath = store.getPersonaObservationPath(agent.slug, "telegram-group-1001");
		expect(readFileSync(observationPath, "utf-8")).toContain("群里刚才在聊什么？");
	});

	it("keeps index and scene observations in prepared context without preloading detailed memory files", async () => {
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
		expect(context.indexMarkdown).toContain("memory/people/telegram-111.md");
		expect(context.sceneObservations).toContain("上次数据库选型那个事你还记得吗");
	});

	it("does not make an extra model call when building prepared context", async () => {
		const completeMock = vi.fn(async () => {
			throw new Error("selector should not be called");
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
		let agent = store.createAgent({ slug: "selector-removed-cat" });
		agent = store.setBuiltinModelConfig(agent.agentId, { provider: "openai", modelId: "gpt-5", apiKey: "test-key" });
		const session = store.createSession(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "111",
			chatKind: "dm",
		});
		writeTextFile(store.getPersonaIndexPath(agent.slug), "## 我认识的人\n- 小王：GPU 租赁平台 → memory/people/telegram-111.md");
		const personaMemory = new PersonaMemoryService(store);
		const event = createEvent({
			channelType: "telegram",
			chatId: "111",
			chatKind: "dm",
			messageId: "m-no-selector",
			senderId: "111",
			senderName: "小王",
			text: "上次那个事你还记得吗",
			occurredAt: "2026-04-03T00:00:00.000Z",
		});

		const context = await personaMemory.buildPreparedContext(agent, session, event);

		expect(context.indexMarkdown).toContain("memory/people/telegram-111.md");
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
		expect(manifest[0]?.description).toBe("Long-time friend who loves photography.");
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
			turnTranscript: "User:\n- Text: 我叫张三，在做一个 GPU 租赁平台\n\nBot:\n- Text: 记得，你之前说在做 GPU 租赁平台。",
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
			turnTranscript: "User:\n- Text: 我叫张三，在做一个 GPU 租赁平台\n\nBot:\n- Text: 记得，你之前说在做 GPU 租赁平台。",
			personaContext: context,
		});
		await waitForBackgroundWork();

		expect(readFileSync(store.getPersonaIndexPath(agent.slug), "utf-8")).toContain("telegram-111.md");
		expect(readFileSync(join(store.getPersonaPeopleDir(agent.slug), "telegram-111.md"), "utf-8")).toContain("GPU 租赁平台");
		expect(readFileSync(join(store.getPersonaPeopleDir(agent.slug), "telegram-111.md"), "utf-8")).toContain("title: \"张三\"");
		expect(readFileSync(join(store.getPersonaScenesDir(agent.slug), "telegram-dm-111.md"), "utf-8")).toContain("description:");
		expect(readFileSync(join(store.getPersonaScenesDir(agent.slug), "telegram-dm-111.md"), "utf-8")).toContain("张三");
		expect(formationPrompt).toContain("Memory files manifest:");
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
			turnTranscript: "User:\n- Text: 测试共享队列\n\nBot:\n- Text: 好的",
			personaContext: { indexMarkdown: "", sceneObservations: "" },
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

	it("formation prompt includes the full run transcript and observation format hint", async () => {
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
			turnTranscript: "User:\n- Text: UNIQUE_INBOUND_TEXT_XYZ\n\nBot:\n- Text: bot reply here\n\nBot:\n- Text: second promise",
			personaContext: context,
		});
		await waitForBackgroundWork();

		expect(capturedPrompt).not.toContain("Current inbound message");
		expect(capturedPrompt).toContain("Task: inspect the temporary persona workspace and update memory for this scene.");
		expect(capturedPrompt).toContain("Observation line format:");
		expect(capturedPrompt).toContain("Full visible transcript for this run:");
		expect(capturedPrompt).toContain("UNIQUE_INBOUND_TEXT_XYZ");
		expect(capturedPrompt).toContain("bot reply here");
		expect(capturedPrompt).toContain("second promise");
		expect(capturedPrompt).not.toContain("Ensure every people/scenes file you touch has YAML frontmatter");
	});
	});
