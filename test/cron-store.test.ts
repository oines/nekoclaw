import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("session-bound cron store", () => {
	let tempHome: string;
	const originalHome = process.env.HOME;

	beforeEach(() => {
		tempHome = mkdtempSync(join(tmpdir(), "nekoclaw-cron-store-"));
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

	it("creates current-session crons using the server timezone by default", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const store = new JsonNekoclawStore();
		const agent = store.createAgent({ slug: "cron-default-timezone-cat" });
		const session = store.createSession(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "123",
			chatKind: "dm",
		});

		const cron = store.createSessionCron(agent.agentId, session.sessionRecordId, {
			scheduleKind: "daily",
			message: "daily reminder",
			hour: 7,
			minute: 0,
		});

		expect(cron.timezone).toBe(store.getDefaultCronTimezone());
		expect(cron.sessionRecordId).toBe(session.sessionRecordId);
		expect(cron.sessionKey).toBe(session.sessionKey);
		expect(cron.createdFromResetGeneration).toBe(0);
	});

	it("lists and cancels crons only within the current session scope", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const store = new JsonNekoclawStore();
		const agent = store.createAgent({ slug: "cron-scope-cat" });
		const sessionA = store.createSession(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "111",
			chatKind: "dm",
		});
		const sessionB = store.createSession(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "222",
			chatKind: "dm",
		});
		const cronA = store.createSessionCron(agent.agentId, sessionA.sessionRecordId, {
			scheduleKind: "once",
			message: "session A",
			runAtLocal: "2099-01-01T07:00",
			timezone: "UTC",
		});
		store.createSessionCron(agent.agentId, sessionB.sessionRecordId, {
			scheduleKind: "once",
			message: "session B",
			runAtLocal: "2099-01-01T08:00",
			timezone: "UTC",
		});

		expect(store.listActiveSessionCrons(agent.agentId, sessionA.sessionRecordId).map((entry) => entry.cronId)).toEqual([cronA.cronId]);
		expect(() => store.cancelSessionCron(agent.agentId, sessionB.sessionRecordId, cronA.cronId)).toThrow(/Unknown cron/);
		const canceled = store.cancelSessionCron(agent.agentId, sessionA.sessionRecordId, cronA.cronId);
		expect(canceled.status).toBe("canceled");
		expect(store.listActiveSessionCrons(agent.agentId, sessionA.sessionRecordId)).toEqual([]);
	});

	it("increments resetGeneration and invalidates session crons on reset", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const store = new JsonNekoclawStore();
		const agent = store.createAgent({ slug: "cron-reset-cat" });
		const session = store.createSession(agent.agentId, {
			channelType: "napcat",
			externalConversationId: "888",
			chatKind: "group",
			chatTitle: "Reset Group",
		});
		const cron = store.createSessionCron(agent.agentId, session.sessionRecordId, {
			scheduleKind: "once",
			message: "reset me",
			runAtLocal: "2099-01-01T07:00",
			timezone: "UTC",
		});

		const reset = store.resetSession(agent.agentId, session.sessionRecordId);

		expect(reset.resetGeneration).toBe(1);
		expect(store.getCron(cron.cronId)?.status).toBe("invalidated");
	});
});
