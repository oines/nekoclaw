import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("store lifecycle services", () => {
	let tempHome: string;
	const originalHome = process.env.HOME;

	beforeEach(() => {
		tempHome = mkdtempSync(join(tmpdir(), "nekoclaw-store-services-"));
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

	it("force deleting an agent cascades session, cron, pair, and runtime cleanup", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");

		const store = new JsonNekoclawStore();
		const agent = store.createAgent({ slug: "cleanup-cat" });
		store.createChannel(agent.agentId, "telegram");
		const session = store.createSession(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "1001",
			chatKind: "dm",
		});
		const cron = store.createSessionCron(agent.agentId, session.sessionRecordId, {
			scheduleKind: "once",
			message: "clean me up",
			runAtLocal: "2099-01-01T07:00",
			timezone: "UTC",
		});
		const pair = store.createOrReusePair(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "1002",
			chatKind: "dm",
			senderId: "42",
			senderName: "Cleanup User",
		});
		store.appendQueueEvent(agent.agentId, {
			type: "enqueue",
			jobId: "job-cleanup",
			timestamp: "2026-04-04T00:00:00.000Z",
			job: {
				jobId: "job-cleanup",
				agentId: agent.agentId,
				kind: "inbound",
				sessionRecordId: session.sessionRecordId,
				sessionKey: session.sessionKey,
				createdAt: "2026-04-04T00:00:00.000Z",
				event: {
					eventType: "message.created",
					channelType: "telegram",
					chatId: session.externalConversationId,
					chatKind: session.chatKind,
					messageId: "m-cleanup",
					sender: { externalId: "42" },
					blocks: [{ kind: "text", text: "hello" }],
					occurredAt: "2026-04-04T00:00:00.000Z",
				},
			},
		});

		const workspaceRoot = store.getWorkspaceRoot(agent.slug);
		const runtimeStatePath = store.getRuntimeStatePath(agent.agentId);
		const queuePath = store.getQueuePath(agent.agentId);
		const auditPath = store.getAuditPath(agent.agentId);

		expect(existsSync(workspaceRoot)).toBe(true);
		expect(existsSync(runtimeStatePath)).toBe(true);
		expect(existsSync(queuePath)).toBe(true);
		expect(existsSync(auditPath)).toBe(true);

		store.deleteAgent(agent.agentId, { force: true });

		expect(store.listAgents()).toEqual([]);
		expect(store.listSessions(agent.agentId)).toEqual([]);
		expect(store.listPairRequests(agent.agentId)).toEqual([]);
		expect(store.getCron(cron.cronId)).toBeUndefined();
		expect(existsSync(store.getPairPath(pair.pairingId))).toBe(false);
		expect(existsSync(workspaceRoot)).toBe(false);
		expect(existsSync(runtimeStatePath)).toBe(false);
		expect(existsSync(queuePath)).toBe(false);
		expect(existsSync(auditPath)).toBe(false);
		expect(() => store.getAgentByRef(agent.agentId)).toThrow(/Unknown agent/);
	});

	it("force removing a channel purges its sessions, invalidates their crons, and emits audits", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");

		const store = new JsonNekoclawStore();
		const agent = store.createAgent({ slug: "channel-cleanup-cat" });
		store.createChannel(agent.agentId, "telegram");
		const session = store.createSession(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "-1001",
			chatKind: "group",
			chatTitle: "Cleanup Group",
		});
		const cron = store.createSessionCron(agent.agentId, session.sessionRecordId, {
			scheduleKind: "once",
			message: "watch me invalidate",
			runAtLocal: "2099-01-01T09:00",
			timezone: "UTC",
		});

		store.removeChannel(agent.agentId, "telegram", { force: true });

		expect(store.listChannels(agent.agentId)).toEqual([]);
		expect(store.listSessions(agent.agentId)).toEqual([]);
		expect(store.getCron(cron.cronId)?.status).toBe("invalidated");
		expect(store.getAuditEntries(agent.agentId).map((entry) => entry.kind)).toContain("session.removed");
		expect(store.getAuditEntries(agent.agentId).map((entry) => entry.kind)).toContain("channel.removed");
	});

	it("resetting a session clears context, invalidates crons, and records invalidated count", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");

		const store = new JsonNekoclawStore();
		const agent = store.createAgent({ slug: "reset-service-cat" });
		const session = store.createSession(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "3001",
			chatKind: "dm",
		});
		const contextPath = store.getSessionContextPath(agent.slug, session.sessionRecordId);
		const cron = store.createSessionCron(agent.agentId, session.sessionRecordId, {
			scheduleKind: "once",
			message: "invalidate on reset",
			runAtLocal: "2099-01-01T10:00",
			timezone: "UTC",
		});
		writeFileSync(contextPath, '{"role":"user","content":"before reset"}\n', "utf-8");
		expect(existsSync(contextPath)).toBe(true);
		expect(readFileSync(contextPath, "utf-8")).toContain("before reset");

		const reset = store.resetSession(agent.agentId, session.sessionRecordId);
		const resetAudit = store.getAuditEntries(agent.agentId).findLast((entry) => entry.kind === "session.reset");

		expect(reset.resetGeneration).toBe(1);
		expect(readFileSync(contextPath, "utf-8")).toBe("");
		expect(store.getCron(cron.cronId)?.status).toBe("invalidated");
		expect(resetAudit?.details).toMatchObject({
			sessionRecordId: session.sessionRecordId,
			sessionKey: session.sessionKey,
			resetGeneration: 1,
			invalidatedCronCount: 1,
		});
	});

	it("accepting a pair creates the session and emits paired lifecycle audits", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");

		const store = new JsonNekoclawStore();
		const agent = store.createAgent({ slug: "pair-accept-cat" });
		const pair = store.createOrReusePair(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "5001",
			chatKind: "dm",
			senderId: "88",
			senderName: "Pair User",
			chatTitle: "Pair Chat",
		});

		const accepted = store.acceptPair(pair.code);
		const matchedSession = store.findSessionByAddress(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "5001",
			chatKind: "dm",
		});
		const auditKinds = store.getAuditEntries(agent.agentId).map((entry) => entry.kind);

		expect(accepted.pair.status).toBe("accepted");
		expect(accepted.session.sessionKey).toBe(pair.sessionKey);
		expect(matchedSession?.sessionRecordId).toBe(accepted.session.sessionRecordId);
		expect(auditKinds).toContain("pair.created");
		expect(auditKinds).toContain("session.created");
		expect(auditKinds).toContain("pair.accepted");
		expect(store.getAuditEntries(agent.agentId).findLast((entry) => entry.kind === "pair.accepted")?.details).toMatchObject({
			code: pair.code,
			sessionRecordId: accepted.session.sessionRecordId,
			sessionKey: accepted.session.sessionKey,
		});
	});
});
