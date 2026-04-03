import { randomUUID } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import type { ChannelSessionAddress, ChannelType, ChatKind, SessionConfig, SessionRecord } from "../types.js";
import { buildSessionKeyFromAddress } from "../session/key.js";
import { appendJsonLine } from "./fs.js";
import { ConfigRepository } from "./config-repository.js";
import { ensureDir, normalizeSessionRecord, nowIso } from "./helpers.js";
import { StorePaths } from "./paths.js";

export class SessionStore {
	constructor(
		private readonly repo: ConfigRepository,
		private readonly paths: StorePaths,
	) {}

	listSessions(agentId?: string): SessionRecord[] {
		const sessions: SessionRecord[] = [];
		for (const [slug, agent] of Object.entries(this.repo.readConfig().agents)) {
			if (agentId && agent.agentId !== agentId) {
				continue;
			}
			for (const [sessionRecordId, session] of Object.entries(agent.sessions)) {
				if (session.status === "active") {
					sessions.push(normalizeSessionRecord(slug, agent.agentId, sessionRecordId, session));
				}
			}
		}
		return sessions.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}

	getSession(agentRef: string, ref: string): SessionRecord {
		const { slug, config } = this.repo.getAgentEntry(agentRef);
		const found = this.listSessions(config.agentId).find(
			(session) =>
				session.sessionRecordId === ref ||
				session.externalConversationId === ref ||
				session.sessionKey === ref,
		);
		if (!found) {
			throw new Error(`Unknown session "${ref}" for agent "${slug}"`);
		}
		return found;
	}

	resolveSessionKey(agentRef: string, address: ChannelSessionAddress): string {
		const { slug } = this.repo.getAgentEntry(agentRef);
		return buildSessionKeyFromAddress({
			agentSlug: slug,
			address,
		});
	}

	findSessionByAddress(agentId: string, address: ChannelSessionAddress): SessionRecord | undefined {
		const { slug, config } = this.repo.getAgentEntry(agentId);
		const sessionKey = buildSessionKeyFromAddress({
			agentSlug: slug,
			address,
		});
		return this.listSessions(config.agentId).find(
			(session) => session.sessionKey === sessionKey && session.status === "active",
		);
	}

	createSession(
		agentRef: string,
		input: {
			channelType: ChannelType;
			externalConversationId: string;
			chatKind: ChatKind;
			chatTitle?: string;
			threadId?: string;
			parentSessionKey?: string;
			sessionKey?: string;
		},
	): SessionRecord {
		const { slug, config } = this.repo.getAgentEntry(agentRef);
		const sessionAddress: ChannelSessionAddress = {
			channelType: input.channelType,
			externalConversationId: input.externalConversationId,
			chatKind: input.chatKind,
			threadId: input.threadId,
			parentSessionKey: input.parentSessionKey,
		};
		const existing = this.findSessionByAddress(config.agentId, sessionAddress);
		if (existing) {
			return existing;
		}
		const timestamp = nowIso();
		const sessionRecordId = randomUUID();
		const sessionKey = input.sessionKey || this.resolveSessionKey(config.agentId, sessionAddress);
		const session = this.repo.updateConfig((storeConfig) => {
			const entry = storeConfig.agents[slug];
			entry.sessions[sessionRecordId] = {
				externalConversationId: input.externalConversationId,
				channelType: input.channelType,
				chatKind: input.chatKind,
				chatTitle: input.chatTitle,
				sessionKey,
				parentSessionKey: input.parentSessionKey,
				threadId: input.threadId,
				lastRoute: {
					channelType: input.channelType,
					externalConversationId: input.externalConversationId,
					threadId: input.threadId,
					updatedAt: timestamp,
				},
				resetGeneration: 0,
				status: "active",
				pairedAt: timestamp,
				updatedAt: timestamp,
			} satisfies SessionConfig;
			entry.updatedAt = timestamp;
			return normalizeSessionRecord(slug, entry.agentId, sessionRecordId, entry.sessions[sessionRecordId]);
		});
		this.ensureSessionPaths(slug, sessionRecordId);
		return session;
	}

	updateSessionLastRoute(
		agentRef: string,
		sessionRef: string,
		input: { externalConversationId: string; threadId?: string },
	): SessionRecord {
		const { slug, config } = this.repo.getAgentEntry(agentRef);
		const current = this.getSession(config.agentId, sessionRef);
		this.repo.updateConfig((storeConfig) => {
			const session = storeConfig.agents[slug].sessions[current.sessionRecordId];
			session.lastRoute = {
				channelType: session.channelType,
				externalConversationId: input.externalConversationId,
				threadId: input.threadId,
				updatedAt: nowIso(),
			};
			session.updatedAt = session.lastRoute.updatedAt;
			storeConfig.agents[slug].updatedAt = session.updatedAt;
		});
		return this.getSession(config.agentId, current.sessionRecordId);
	}

	updateSessionChatTitle(agentRef: string, sessionRef: string, chatTitle: string): SessionRecord {
		const { slug, config } = this.repo.getAgentEntry(agentRef);
		const current = this.getSession(config.agentId, sessionRef);
		const normalizedTitle = chatTitle.trim();
		if (!normalizedTitle || current.chatTitle === normalizedTitle) {
			return current;
		}
		this.repo.updateConfig((storeConfig) => {
			const session = storeConfig.agents[slug].sessions[current.sessionRecordId];
			session.chatTitle = normalizedTitle;
			session.updatedAt = nowIso();
			storeConfig.agents[slug].updatedAt = session.updatedAt;
		});
		return this.getSession(config.agentId, current.sessionRecordId);
	}

	setSessionModelOverride(
		agentRef: string,
		sessionRef: string,
		input: { provider: string; modelId: string },
	): SessionRecord {
		const { slug, config } = this.repo.getAgentEntry(agentRef);
		const current = this.getSession(config.agentId, sessionRef);
		const provider = input.provider.trim();
		const modelId = input.modelId.trim();
		if (!provider || !modelId) {
			throw new Error("Session model override requires provider/model");
		}
		const updatedAt = nowIso();
		this.repo.updateConfig((storeConfig) => {
			const session = storeConfig.agents[slug].sessions[current.sessionRecordId];
			session.modelOverride = {
				provider,
				modelId,
				updatedAt,
			};
			session.updatedAt = updatedAt;
			storeConfig.agents[slug].updatedAt = updatedAt;
		});
		return this.getSession(config.agentId, current.sessionRecordId);
	}

	clearSessionModelOverride(agentRef: string, sessionRef: string): SessionRecord {
		const { slug, config } = this.repo.getAgentEntry(agentRef);
		const current = this.getSession(config.agentId, sessionRef);
		const updatedAt = nowIso();
		this.repo.updateConfig((storeConfig) => {
			const session = storeConfig.agents[slug].sessions[current.sessionRecordId];
			session.modelOverride = undefined;
			session.updatedAt = updatedAt;
			storeConfig.agents[slug].updatedAt = updatedAt;
		});
		return this.getSession(config.agentId, current.sessionRecordId);
	}

	resetSession(agentRef: string, sessionRef: string): SessionRecord {
		const { slug, config } = this.repo.getAgentEntry(agentRef);
		const current = this.getSession(config.agentId, sessionRef);
		writeFileSync(this.paths.getSessionContextPath(slug, current.sessionRecordId), "", "utf-8");
		const updatedAt = nowIso();
		this.repo.updateConfig((storeConfig) => {
			const session = storeConfig.agents[slug].sessions[current.sessionRecordId];
			session.modelOverride = undefined;
			session.resetGeneration = (session.resetGeneration ?? 0) + 1;
			session.updatedAt = updatedAt;
			storeConfig.agents[slug].updatedAt = updatedAt;
		});
		return this.getSession(config.agentId, current.sessionRecordId);
	}

	removeSession(agentRef: string, ref: string, options?: { purge?: boolean }): SessionRecord {
		const { slug, config } = this.repo.getAgentEntry(agentRef);
		const current = this.getSession(config.agentId, ref);
		if (options?.purge) {
			this.repo.updateConfig((storeConfig) => {
				delete storeConfig.agents[slug].sessions[current.sessionRecordId];
				storeConfig.agents[slug].updatedAt = nowIso();
			});
			rmSync(this.paths.getSessionDir(slug, current.sessionRecordId), { recursive: true, force: true });
			return current;
		}
		this.repo.updateConfig((storeConfig) => {
			const session = storeConfig.agents[slug].sessions[current.sessionRecordId];
			session.status = "removed";
			session.updatedAt = nowIso();
			storeConfig.agents[slug].updatedAt = session.updatedAt;
		});
		return this.getSession(config.agentId, current.sessionRecordId);
	}

	appendSessionLog(agentRef: string, sessionRecordId: string, value: unknown): void {
		const { slug } = this.repo.getAgentEntry(agentRef);
		appendJsonLine(this.paths.getSessionLogPath(slug, sessionRecordId), value);
	}

	getSessionDir(slug: string, sessionRecordId: string): string {
		return this.paths.getSessionDir(slug, sessionRecordId);
	}

	getSessionLogPath(slug: string, sessionRecordId: string): string {
		return this.paths.getSessionLogPath(slug, sessionRecordId);
	}

	getSessionContextPath(slug: string, sessionRecordId: string): string {
		return this.paths.getSessionContextPath(slug, sessionRecordId);
	}

	getSessionAttachmentsDir(slug: string, sessionRecordId: string): string {
		return this.paths.getSessionAttachmentsDir(slug, sessionRecordId);
	}

	private ensureSessionPaths(slug: string, sessionRecordId: string): void {
		const sessionDir = this.paths.getSessionDir(slug, sessionRecordId);
		for (const dir of [sessionDir, this.paths.getSessionAttachmentsDir(slug, sessionRecordId), `${sessionDir}/scratch`]) {
			ensureDir(dir);
		}
		for (const path of [this.paths.getSessionLogPath(slug, sessionRecordId), this.paths.getSessionContextPath(slug, sessionRecordId)]) {
			if (!existsSync(path)) {
				writeFileSync(path, "", "utf-8");
			}
		}
	}
}
