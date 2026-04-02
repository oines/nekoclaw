import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendJsonLine } from "../src/store/fs.js";
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

describe("runtime directory service", () => {
	let tempHome: string;
	const originalHome = process.env.HOME;

	beforeEach(() => {
		tempHome = mkdtempSync(join(tmpdir(), "nekoclaw-runtime-directory-"));
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

	it("builds a runtime-known directory snapshot from sessions, pairs, logs, and the current event", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { RuntimeDirectoryService } = await import("../src/runtime/runtime-directory.js");

		const store = new JsonNekoclawStore();
		const agent = store.createAgent({ slug: "directory-cat" });
		store.createChannel(agent.agentId, "telegram");
		store.createChannel(agent.agentId, "napcat");

		const dmSession = store.createSession(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "123",
			chatKind: "dm",
		});
		const groupSession = store.createSession(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "-1001",
			chatKind: "group",
		});
		store.createOrReusePair(agent.agentId, {
			channelType: "napcat",
			externalConversationId: "456",
			chatKind: "dm",
			sessionKey: "agent:directory-cat:napcat:direct:456",
			senderId: "456",
			senderName: "Bob",
		});

		appendJsonLine(store.getSessionLogPath(agent.slug, dmSession.sessionRecordId), {
			eventType: "message.created",
			channelType: "telegram",
			chatId: "123",
			chatKind: "dm",
			occurredAt: "2026-04-02T08:00:00.000Z",
			sender: { externalId: "123", displayName: "Alice" },
		});
		appendJsonLine(store.getSessionLogPath(agent.slug, groupSession.sessionRecordId), {
			eventType: "message.created",
			channelType: "telegram",
			chatId: "-1001",
			chatKind: "group",
			chatTitle: "Tech Group",
			occurredAt: "2026-04-02T08:05:00.000Z",
			sender: { externalId: "789", displayName: "Carol" },
		});

		const service = new RuntimeDirectoryService(store);
		const snapshot = service.buildSnapshot(
			agent,
			groupSession,
			createEvent({
				channelType: "telegram",
				chatId: "-1001",
				chatKind: "group",
				messageId: "m3",
				senderId: "321",
				senderName: "Dave",
				text: "群里现在情况怎么样",
				occurredAt: "2026-04-02T08:10:00.000Z",
				chatTitle: "Tech Group",
			}),
		);

			expect(snapshot.availableChannels).toEqual(["qq", "telegram"]);
		expect(snapshot.contacts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					account: "telegram:dm:123",
					displayName: "Alice",
					pairedSessionKey: dmSession.sessionKey,
				}),
				expect.objectContaining({
					account: "telegram:dm:321",
					displayName: "Dave",
					sourceHints: ["seen_in_group"],
				}),
					expect.objectContaining({
						account: "qq:dm:456",
						displayName: "Bob",
						sourceHints: ["pair_request"],
					}),
			]),
		);
		expect(snapshot.groups).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					groupRef: "telegram:group:-1001",
					title: "Tech Group",
					pairedSessionKey: groupSession.sessionKey,
				}),
			]),
		);
		expect(snapshot.groupMembers["telegram:group:-1001"]).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ account: "telegram:dm:789", displayName: "Carol", source: "runtime_seen" }),
				expect.objectContaining({ account: "telegram:dm:321", displayName: "Dave", source: "runtime_seen" }),
			]),
		);
	});

	it("preserves QQ group titles from current events in the runtime snapshot", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { RuntimeDirectoryService } = await import("../src/runtime/runtime-directory.js");

		const store = new JsonNekoclawStore();
		const agent = store.createAgent({ slug: "directory-qq" });
		store.createChannel(agent.agentId, "napcat");
		const groupSession = store.createSession(agent.agentId, {
			channelType: "napcat",
			externalConversationId: "244962071",
			chatKind: "group",
		});

		const service = new RuntimeDirectoryService(store);
		const snapshot = service.buildSnapshot(
			agent,
			groupSession,
			createEvent({
				channelType: "napcat",
				chatId: "244962071",
				chatKind: "group",
				messageId: "m1",
				senderId: "3184675714",
				senderName: "oines",
				text: "hello group",
				occurredAt: "2026-04-02T08:20:00.000Z",
				chatTitle: "TIAL Members",
			}),
		);

		expect(snapshot.groups).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					groupRef: "qq:group:244962071",
					title: "TIAL Members",
					pairedSessionKey: groupSession.sessionKey,
				}),
			]),
		);
	});
});
