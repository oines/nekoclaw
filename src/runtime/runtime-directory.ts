import { readJsonLines } from "../store/fs.js";
import { JsonNekoclawStore } from "../store/json-store.js";
import type {
	AgentSpec,
	ChannelType,
	InboundMessageEvent,
	PairRequest,
	RuntimeDirectoryContactSnapshot,
	RuntimeDirectoryGroupMemberSnapshot,
	RuntimeDirectoryGroupSnapshot,
	RuntimeDirectorySnapshot,
	SessionRecord,
} from "../types.js";

function toExposedChannel(channel: ChannelType): "telegram" | "qq" {
	return channel === "napcat" ? "qq" : "telegram";
}

type KnownLogEvent = Partial<InboundMessageEvent> & { timestamp?: string; type?: string; channel?: string };

function normalizeRefId(value: string): string {
	return value.trim();
}

export function buildContactRef(channel: ChannelType, externalUserId: string): string {
	return `${toExposedChannel(channel)}:dm:${normalizeRefId(externalUserId)}`;
}

export function buildGroupRef(channel: ChannelType, externalConversationId: string): string {
	return `${toExposedChannel(channel)}:group:${normalizeRefId(externalConversationId)}`;
}

export function parseTargetRef(value: string): { channelType: ChannelType; chatKind: "dm" | "group"; externalConversationId: string } | undefined {
	const match = value.trim().match(/^(telegram|qq|napcat):(dm|group):(.+)$/);
	if (!match?.[1] || !match[2] || !match[3]) {
		return undefined;
	}
	const channel = match[1] === "qq" ? "napcat" : (match[1] as ChannelType);
	return {
		channelType: channel,
		chatKind: match[2] as "dm" | "group",
		externalConversationId: normalizeRefId(match[3]),
	};
}

function upsertContact(
	target: Map<string, RuntimeDirectoryContactSnapshot>,
	input: RuntimeDirectoryContactSnapshot,
): void {
	const existing = target.get(input.account);
	if (!existing) {
		target.set(input.account, {
			...input,
			sourceHints: Array.from(new Set(input.sourceHints)).sort(),
		});
		return;
	}
	target.set(input.account, {
		account: existing.account,
		channel: existing.channel,
		displayName: input.displayName || existing.displayName,
		lastSeenAt: input.lastSeenAt > existing.lastSeenAt ? input.lastSeenAt : existing.lastSeenAt,
		pairedSessionKey: input.pairedSessionKey || existing.pairedSessionKey,
		sourceHints: Array.from(new Set([...existing.sourceHints, ...input.sourceHints])).sort(),
	});
}

function upsertGroup(
	target: Map<string, RuntimeDirectoryGroupSnapshot>,
	input: RuntimeDirectoryGroupSnapshot,
): void {
	const existing = target.get(input.groupRef);
	if (!existing) {
		target.set(input.groupRef, input);
		return;
	}
	target.set(input.groupRef, {
		groupRef: existing.groupRef,
		channel: existing.channel,
		title: input.title || existing.title,
		lastSeenAt: input.lastSeenAt > existing.lastSeenAt ? input.lastSeenAt : existing.lastSeenAt,
		pairedSessionKey: input.pairedSessionKey || existing.pairedSessionKey,
	});
}

function upsertGroupMember(
	target: Map<string, Map<string, RuntimeDirectoryGroupMemberSnapshot>>,
	groupRef: string,
	input: RuntimeDirectoryGroupMemberSnapshot,
): void {
	const groupMembers = target.get(groupRef) ?? new Map<string, RuntimeDirectoryGroupMemberSnapshot>();
	const existing = groupMembers.get(input.account);
	if (!existing) {
		groupMembers.set(input.account, input);
		target.set(groupRef, groupMembers);
		return;
	}
	groupMembers.set(input.account, {
		account: existing.account,
		displayName: input.displayName || existing.displayName,
		lastSeenAt: input.lastSeenAt > existing.lastSeenAt ? input.lastSeenAt : existing.lastSeenAt,
		source: existing.source === "napcat_live" ? "napcat_live" : input.source,
	});
	target.set(groupRef, groupMembers);
}

function addCurrentEvent(
	contacts: Map<string, RuntimeDirectoryContactSnapshot>,
	groups: Map<string, RuntimeDirectoryGroupSnapshot>,
	groupMembers: Map<string, Map<string, RuntimeDirectoryGroupMemberSnapshot>>,
	session: SessionRecord,
	event: InboundMessageEvent,
): void {
	if (event.sender.externalId) {
		upsertContact(contacts, {
				account: buildContactRef(event.channelType, event.sender.externalId),
				displayName: event.sender.displayName,
				channel: toExposedChannel(event.channelType),
			lastSeenAt: event.occurredAt,
			pairedSessionKey: event.chatKind === "dm" ? session.sessionKey : undefined,
			sourceHints: [event.chatKind === "dm" ? "seen_in_dm" : "seen_in_group"],
		});
	}
	if (event.chatKind === "group") {
		const groupRef = buildGroupRef(event.channelType, event.chatId);
		upsertGroup(groups, {
			groupRef,
			title: event.chatTitle,
			channel: toExposedChannel(event.channelType),
			lastSeenAt: event.occurredAt,
			pairedSessionKey: session.sessionKey,
		});
		if (event.sender.externalId) {
			upsertGroupMember(groupMembers, groupRef, {
				account: buildContactRef(event.channelType, event.sender.externalId),
				displayName: event.sender.displayName,
				lastSeenAt: event.occurredAt,
				source: "runtime_seen",
			});
		}
	}
}

function addSession(
	contacts: Map<string, RuntimeDirectoryContactSnapshot>,
	groups: Map<string, RuntimeDirectoryGroupSnapshot>,
	session: SessionRecord,
): void {
	if (session.chatKind === "dm") {
		upsertContact(contacts, {
				account: buildContactRef(session.channelType, session.externalConversationId),
				channel: toExposedChannel(session.channelType),
			lastSeenAt: session.updatedAt,
			pairedSessionKey: session.sessionKey,
			sourceHints: ["paired_session"],
		});
		return;
	}
	upsertGroup(groups, {
		groupRef: buildGroupRef(session.channelType, session.externalConversationId),
		title: session.chatTitle,
		channel: toExposedChannel(session.channelType),
		lastSeenAt: session.updatedAt,
		pairedSessionKey: session.sessionKey,
	});
}

function addPair(
	contacts: Map<string, RuntimeDirectoryContactSnapshot>,
	groups: Map<string, RuntimeDirectoryGroupSnapshot>,
	pair: PairRequest,
): void {
	if (pair.chatKind === "dm") {
		upsertContact(contacts, {
				account: buildContactRef(pair.channelType, pair.externalConversationId),
				displayName: pair.senderName,
				channel: toExposedChannel(pair.channelType),
			lastSeenAt: pair.updatedAt,
			pairedSessionKey: pair.status === "accepted" ? pair.sessionKey : undefined,
			sourceHints: [pair.status === "pending" ? "pair_request" : "paired_session"],
		});
		return;
	}
		upsertGroup(groups, {
			groupRef: buildGroupRef(pair.channelType, pair.externalConversationId),
			title: pair.chatTitle,
			channel: toExposedChannel(pair.channelType),
		lastSeenAt: pair.updatedAt,
		pairedSessionKey: pair.status === "accepted" ? pair.sessionKey : undefined,
	});
}

function addLogEntry(
	contacts: Map<string, RuntimeDirectoryContactSnapshot>,
	groups: Map<string, RuntimeDirectoryGroupSnapshot>,
	groupMembers: Map<string, Map<string, RuntimeDirectoryGroupMemberSnapshot>>,
	session: SessionRecord,
	entry: KnownLogEvent,
): void {
	const eventChannel = entry.channelType === "telegram" || entry.channelType === "napcat" ? entry.channelType : session.channelType;
	const chatKind = entry.chatKind === "dm" || entry.chatKind === "group" ? entry.chatKind : session.chatKind;
	const occurredAt = typeof entry.occurredAt === "string" ? entry.occurredAt : typeof entry.timestamp === "string" ? entry.timestamp : session.updatedAt;
	const senderId = typeof entry.sender?.externalId === "string" ? entry.sender.externalId : undefined;
	const senderName = typeof entry.sender?.displayName === "string" ? entry.sender.displayName : undefined;
	const chatId = typeof entry.chatId === "string" ? entry.chatId : session.externalConversationId;
	const chatTitle = typeof entry.chatTitle === "string" ? entry.chatTitle : undefined;
	if (senderId) {
		upsertContact(contacts, {
				account: buildContactRef(eventChannel, senderId),
				displayName: senderName,
				channel: toExposedChannel(eventChannel),
			lastSeenAt: occurredAt,
			pairedSessionKey: chatKind === "dm" ? session.sessionKey : undefined,
			sourceHints: [chatKind === "dm" ? "seen_in_dm" : "seen_in_group"],
		});
	}
	if (chatKind === "group") {
		const groupRef = buildGroupRef(eventChannel, chatId);
			upsertGroup(groups, {
				groupRef,
				title: chatTitle,
				channel: toExposedChannel(eventChannel),
			lastSeenAt: occurredAt,
			pairedSessionKey: session.sessionKey,
		});
		if (senderId) {
			upsertGroupMember(groupMembers, groupRef, {
				account: buildContactRef(eventChannel, senderId),
				displayName: senderName,
				lastSeenAt: occurredAt,
				source: "runtime_seen",
			});
		}
	}
}

export class RuntimeDirectoryService {
	constructor(private readonly store: JsonNekoclawStore) {}

	buildSnapshot(agent: AgentSpec, session: SessionRecord, event: InboundMessageEvent): RuntimeDirectorySnapshot {
		const contacts = new Map<string, RuntimeDirectoryContactSnapshot>();
		const groups = new Map<string, RuntimeDirectoryGroupSnapshot>();
		const groupMembers = new Map<string, Map<string, RuntimeDirectoryGroupMemberSnapshot>>();

		for (const activeSession of this.store.listSessions(agent.agentId)) {
			addSession(contacts, groups, activeSession);
			const logPath = this.store.getSessionLogPath(agent.slug, activeSession.sessionRecordId);
			for (const entry of readJsonLines<KnownLogEvent>(logPath)) {
				addLogEntry(contacts, groups, groupMembers, activeSession, entry);
			}
		}

		for (const pair of this.store.listPairRequests(agent.agentId)) {
			addPair(contacts, groups, pair);
		}

		addCurrentEvent(contacts, groups, groupMembers, session, event);

		return {
			contacts: Array.from(contacts.values()).sort((left, right) => left.account.localeCompare(right.account)),
			groups: Array.from(groups.values()).sort((left, right) => left.groupRef.localeCompare(right.groupRef)),
			groupMembers: Object.fromEntries(
				Array.from(groupMembers.entries())
					.sort(([left], [right]) => left.localeCompare(right))
					.map(([groupRef, members]) => [
						groupRef,
						Array.from(members.values()).sort((left, right) => left.account.localeCompare(right.account)),
					]),
			),
				availableChannels: this.store.listChannels(agent.agentId).map((channel) => toExposedChannel(channel.type)).sort(),
			};
		}
	}
