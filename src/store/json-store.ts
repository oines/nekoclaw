import { NEKOCLAW_RUNTIME_CONTROL_DIR } from "../config.js";
import type {
	AgentSpec,
	AdminIdentity,
	AuditEntry,
	ChannelSessionAddress,
	ChannelSpec,
	ChannelType,
	ChatKind,
	ModelConfig,
	PairRequest,
	PairingConfig,
	QueueEvent,
	RunJob,
	RuntimeControlAction,
	RuntimeProcessState,
	RuntimeState,
	SessionRecord,
} from "../types.js";
import { AgentStore, type CreateAgentInput, type UpdateAgentInput } from "./agent-store.js";
import { AuditStore } from "./audit-store.js";
import { ChannelStore } from "./channel-store.js";
import { ConfigRepository } from "./config-repository.js";
import { nowIso } from "./helpers.js";
import { ModelStore } from "./model-store.js";
import { PairStore } from "./pair-store.js";
import { StorePaths } from "./paths.js";
import { RuntimeStateStore } from "./runtime-state-store.js";
import { SessionStore } from "./session-store.js";

export { CreateAgentInput, UpdateAgentInput };

export class JsonNekoclawStore {
	private readonly paths = new StorePaths();

	private readonly repo = new ConfigRepository(this.paths);

	private readonly audits = new AuditStore(this.paths);

	private readonly agents = new AgentStore(this.repo, this.paths);

	private readonly channels = new ChannelStore(this.repo);

	private readonly models = new ModelStore(this.repo, this.paths);

	private readonly sessions = new SessionStore(this.repo, this.paths);

	private readonly pairs = new PairStore(this.repo, this.paths);

	private readonly runtime = new RuntimeStateStore(this.paths);

	// #region Filesystem Paths

	getWorkspaceRoot(slug: string): string {
		return this.agents.getWorkspaceRoot(slug);
	}

	getSoulPath(slug: string): string {
		return this.agents.getSoulPath(slug);
	}

	getAgentsPath(slug: string): string {
		return this.agents.getAgentsPath(slug);
	}

	getMemoryPath(slug: string): string {
		return this.agents.getMemoryPath(slug);
	}

	getSkillsDir(slug: string): string {
		return this.agents.getSkillsDir(slug);
	}

	getRuntimeAgentDir(slug: string): string {
		return this.agents.getRuntimeAgentDir(slug);
	}

	getRuntimeModelsPath(slug: string): string {
		return this.models.getRuntimeModelsPath(slug);
	}

	getPersonaDir(slug: string): string {
		return this.agents.getPersonaDir(slug);
	}

	getPersonaIndexPath(slug: string): string {
		return this.agents.getPersonaIndexPath(slug);
	}

	getPersonaPeopleDir(slug: string): string {
		return this.agents.getPersonaPeopleDir(slug);
	}

	getPersonaScenesDir(slug: string): string {
		return this.agents.getPersonaScenesDir(slug);
	}

	getPersonaObservationsDir(slug: string): string {
		return this.agents.getPersonaObservationsDir(slug);
	}

	getPersonaObservationPath(slug: string, sceneRef: string): string {
		return this.agents.getPersonaObservationPath(slug, sceneRef);
	}

	getPersonaControlDir(slug: string): string {
		return this.agents.getPersonaControlDir(slug);
	}

	getPersonaDreamStatePath(slug: string): string {
		return this.agents.getPersonaDreamStatePath(slug);
	}

	getSessionDir(slug: string, sessionRecordId: string): string {
		return this.sessions.getSessionDir(slug, sessionRecordId);
	}

	getSessionLogPath(slug: string, sessionRecordId: string): string {
		return this.sessions.getSessionLogPath(slug, sessionRecordId);
	}

	getSessionContextPath(slug: string, sessionRecordId: string): string {
		return this.sessions.getSessionContextPath(slug, sessionRecordId);
	}

	getSessionAttachmentsDir(slug: string, sessionRecordId: string): string {
		return this.sessions.getSessionAttachmentsDir(slug, sessionRecordId);
	}

	getRuntimeStatePath(agentId: string): string {
		return this.paths.getRuntimeStatePath(agentId);
	}

	getQueuePath(agentId: string): string {
		return this.paths.getQueuePath(agentId);
	}

	getAuditPath(agentId: string): string {
		return this.paths.getAuditPath(agentId);
	}

	getPairPath(pairingId: string): string {
		return this.paths.getPairPath(pairingId);
	}

	getRuntimeControlPath(requestId: string): string {
		return this.paths.getRuntimeControlPath(requestId);
	}

	// #endregion

	// #region Core Initialization & Misc

	getPairingConfig(): PairingConfig {
		return this.repo.readConfig().pairing;
	}

	// #endregion

	// #region Agents Accessors

	listAgents(): AgentSpec[] {
		return this.agents.listAgents();
	}

	getAgentByRef(ref: string): AgentSpec {
		return this.agents.getAgentByRef(ref);
	}

	// #endregion

	// #region Admins Accessors

	listAdmins(agentRef: string): AdminIdentity[] {
		return this.agents.listAdmins(agentRef);
	}

	addAdmin(
		agentRef: string,
		input: {
			channelType: ChannelType;
			externalUserId: string;
			displayName?: string;
		},
	): AdminIdentity {
		const agent = this.getAgentByRef(agentRef);
		const admin = this.agents.addAdmin(agentRef, input);
		this.audit(agent.agentId, "admin.added", {
			channelType: admin.channelType,
			externalUserId: admin.externalUserId,
			displayName: admin.displayName,
		});
		return admin;
	}

	removeAdmin(agentRef: string, channelType: ChannelType, externalUserId: string): AdminIdentity {
		const agent = this.getAgentByRef(agentRef);
		const admin = this.agents.removeAdmin(agentRef, channelType, externalUserId);
		this.audit(agent.agentId, "admin.removed", {
			channelType: admin.channelType,
			externalUserId: admin.externalUserId,
		});
		return admin;
	}

	isAdmin(agentRef: string, channelType: ChannelType, externalUserId?: string): boolean {
		return this.agents.isAdmin(agentRef, channelType, externalUserId);
	}

	// #endregion

	// #region Agent Mutators

	createAgent(input: CreateAgentInput): AgentSpec {
		const agent = this.agents.createAgent(input);
		this.runtime.writeRuntimeState({
			agentId: agent.agentId,
			containerStatus: "missing",
			updatedAt: nowIso(),
		});
		this.audit(agent.agentId, "agent.created", { slug: agent.slug });
		return agent;
	}

	updateAgent(ref: string, patch: UpdateAgentInput): AgentSpec {
		const agent = this.agents.updateAgent(ref, patch);
		this.audit(agent.agentId, "agent.updated", patch as Record<string, unknown>);
		return agent;
	}

	deleteAgent(ref: string, options?: { force?: boolean }): AgentSpec {
		const agent = this.getAgentByRef(ref);
		const activeChannels = this.listChannels(agent.agentId);
		const activeSessions = this.listSessions(agent.agentId);
		if (!options?.force && (activeChannels.length > 0 || activeSessions.length > 0)) {
			throw new Error(`Agent "${agent.slug}" still has channels or sessions. Use --force to remove it.`);
		}
		for (const session of activeSessions) {
			this.removeSession(agent.agentId, session.sessionRecordId, { purge: true });
		}
		this.pairs.deletePairsForAgent(agent.agentId);
		this.runtime.removeAgentArtifacts(agent.agentId);
		this.agents.removeWorkspace(agent.slug);
		return this.agents.deleteAgentConfig(agent.agentId);
	}

	// #endregion

	// #region Channels Accessors

	listChannels(agentId?: string): ChannelSpec[] {
		return this.channels.listChannels(agentId);
	}

	getChannel(agentRef: string, type: ChannelType): ChannelSpec {
		return this.channels.getChannel(agentRef, type);
	}

	createChannel(agentRef: string, type: ChannelType): ChannelSpec {
		const channel = this.channels.createChannel(agentRef, type);
		this.audit(channel.agentId, "channel.created", { type });
		return channel;
	}

	removeChannel(agentRef: string, type: ChannelType, options?: { force?: boolean }): ChannelSpec {
		const agent = this.getAgentByRef(agentRef);
		const channel = this.getChannel(agent.agentId, type);
		const sessions = this.listSessions(agent.agentId).filter((session) => session.channelType === type);
		if (!options?.force && sessions.length > 0) {
			throw new Error(`The ${type} channel still has paired sessions. Remove them first or use --force.`);
		}
		for (const session of sessions) {
			this.removeSession(agent.agentId, session.sessionRecordId, { purge: true });
		}
		const removed = this.channels.removeChannel(agentRef, type);
		this.audit(agent.agentId, "channel.removed", { type });
		return removed ?? channel;
	}

	setChannelToken(agentRef: string, type: ChannelType, token: string): void {
		this.channels.setChannelToken(agentRef, type, token);
		const agent = this.getAgentByRef(agentRef);
		this.audit(agent.agentId, "channel.token_saved", { type });
	}

	getChannelToken(agentId: string, type: ChannelType): string | undefined {
		return this.channels.getChannelToken(agentId, type);
	}

	getTelegramChannelConfig(agentId: string) {
		return this.channels.getTelegramChannelConfig(agentId);
	}

	getNapcatChannelConfig(agentId: string) {
		return this.channels.getNapcatChannelConfig(agentId);
	}

	setNapcatEndpoint(agentRef: string, input: { wsUrl: string; selfId?: string }): void {
		this.channels.setNapcatEndpoint(agentRef, input);
		const agent = this.getAgentByRef(agentRef);
		this.audit(agent.agentId, "channel.endpoint_saved", {
			type: "napcat",
			wsUrl: input.wsUrl,
			selfId: input.selfId,
		});
	}

	setChannelGroupTrigger(agentRef: string, type: ChannelType, groupTrigger: "all" | "mention"): void {
		this.channels.setGroupTrigger(agentRef, type, groupTrigger);
		const agent = this.getAgentByRef(agentRef);
		this.audit(agent.agentId, "channel.group_trigger_saved", {
			type,
			groupTrigger,
		});
	}

	// #endregion

	// #region Sessions Accessors

	listSessions(agentId?: string): SessionRecord[] {
		return this.sessions.listSessions(agentId);
	}

	getSession(agentRef: string, ref: string): SessionRecord {
		return this.sessions.getSession(agentRef, ref);
	}

	resolveSessionKey(agentRef: string, address: ChannelSessionAddress): string {
		return this.sessions.resolveSessionKey(agentRef, address);
	}

	findSessionByAddress(agentId: string, address: ChannelSessionAddress): SessionRecord | undefined {
		return this.sessions.findSessionByAddress(agentId, address);
	}

	// #endregion

	// #region Session Mutators

	createSession(
		agentRef: string,
		input: {
			channelType: ChannelType;
			externalConversationId: string;
			chatKind: ChatKind;
			threadId?: string;
			parentSessionKey?: string;
			sessionKey?: string;
		},
	): SessionRecord {
		const session = this.sessions.createSession(agentRef, input);
		this.audit(session.agentId, "session.created", {
			sessionRecordId: session.sessionRecordId,
			sessionKey: session.sessionKey,
			channelType: session.channelType,
			chatKind: session.chatKind,
		});
		return session;
	}

	updateSessionLastRoute(
		agentRef: string,
		sessionRef: string,
		input: { externalConversationId: string; threadId?: string },
	): SessionRecord {
		return this.sessions.updateSessionLastRoute(agentRef, sessionRef, input);
	}

	setSessionModelOverride(
		agentRef: string,
		sessionRef: string,
		input: { provider: string; modelId: string },
	): SessionRecord {
		const session = this.sessions.setSessionModelOverride(agentRef, sessionRef, input);
		this.audit(session.agentId, "session.model_override_set", {
			sessionRecordId: session.sessionRecordId,
			sessionKey: session.sessionKey,
			provider: input.provider,
			modelId: input.modelId,
		});
		return session;
	}

	clearSessionModelOverride(agentRef: string, sessionRef: string): SessionRecord {
		const session = this.sessions.clearSessionModelOverride(agentRef, sessionRef);
		this.audit(session.agentId, "session.model_override_cleared", {
			sessionRecordId: session.sessionRecordId,
			sessionKey: session.sessionKey,
		});
		return session;
	}

	resetSession(agentRef: string, sessionRef: string): SessionRecord {
		const session = this.sessions.resetSession(agentRef, sessionRef);
		this.audit(session.agentId, "session.reset", {
			sessionRecordId: session.sessionRecordId,
			sessionKey: session.sessionKey,
		});
		return session;
	}

	removeSession(agentRef: string, ref: string, options?: { purge?: boolean }): SessionRecord {
		const session = this.sessions.removeSession(agentRef, ref, options);
		this.audit(session.agentId, "session.removed", {
			sessionRecordId: session.sessionRecordId,
			sessionKey: session.sessionKey,
			purge: Boolean(options?.purge),
		});
		return session;
	}

	// #endregion

	// #region Pairing Request Methods

	listPairRequests(agentId?: string): PairRequest[] {
		return this.pairs.listPairRequests(agentId);
	}

	createOrReusePair(
		agentRef: string,
		input: {
			channelType: ChannelType;
			externalConversationId: string;
			chatKind: ChatKind;
			threadId?: string;
			parentSessionKey?: string;
			sessionKey?: string;
			senderId?: string;
			senderName?: string;
			chatTitle?: string;
			ttlMinutes?: number;
		},
	): PairRequest {
		const agent = this.getAgentByRef(agentRef);
		const pair = this.pairs.createOrReusePair(agent.agentId, {
			...input,
			sessionKey:
				input.sessionKey ||
				this.resolveSessionKey(agent.agentId, {
					channelType: input.channelType,
					externalConversationId: input.externalConversationId,
					chatKind: input.chatKind,
					threadId: input.threadId,
					parentSessionKey: input.parentSessionKey,
				}),
		});
		this.audit(agent.agentId, "pair.created", {
			code: pair.code,
			sessionKey: pair.sessionKey,
			channelType: pair.channelType,
			chatKind: pair.chatKind,
		});
		return pair;
	}

	touchPairPrompt(pairingId: string): PairRequest {
		return this.pairs.touchPairPrompt(pairingId);
	}

	getPairByCode(code: string): PairRequest {
		return this.pairs.getPairByCode(code);
	}

	acceptPair(code: string): { pair: PairRequest; session: SessionRecord } {
		const pair = this.getPairByCode(code);
		const session = this.createSession(pair.agentId, {
			channelType: pair.channelType,
			externalConversationId: pair.externalConversationId,
			chatKind: pair.chatKind,
			threadId: pair.threadId,
			parentSessionKey: pair.parentSessionKey,
			sessionKey: pair.sessionKey,
		});
		const updated = this.pairs.markAccepted(code);
		this.audit(pair.agentId, "pair.accepted", {
			code,
			sessionRecordId: session.sessionRecordId,
			sessionKey: session.sessionKey,
		});
		return { pair: updated, session };
	}

	rejectPair(code: string): PairRequest {
		const pair = this.pairs.markRejected(code);
		this.audit(pair.agentId, "pair.rejected", { code });
		return pair;
	}

	deletePairRequestsForAgent(agentId: string): void {
		this.pairs.deletePairsForAgent(agentId);
	}

	readSoul(agentRef: string): string {
		return this.agents.readSoul(agentRef);
	}

	readAgents(agentRef: string): string {
		return this.agents.readAgents(agentRef);
	}

	writeSoul(agentRef: string, content: string): void {
		const agent = this.getAgentByRef(agentRef);
		this.agents.writeSoul(agentRef, content);
		this.audit(agent.agentId, "soul.updated", {});
	}

	readMemory(agentRef: string): string {
		return this.agents.readMemory(agentRef);
	}

	writeMemory(agentRef: string, content: string): void {
		const agent = this.getAgentByRef(agentRef);
		this.agents.writeMemory(agentRef, content);
		this.audit(agent.agentId, "memory.updated", {});
	}

	readRuntimeModelsConfig(agentRef: string): Record<string, unknown> | undefined {
		return this.models.readRuntimeModelsConfig(agentRef);
	}

	writeRuntimeModelsConfig(agentRef: string, config: Record<string, unknown>, details: Record<string, unknown>): void {
		const agent = this.getAgentByRef(agentRef);
		this.models.writeRuntimeModelsConfig(agentRef, config);
		this.audit(agent.agentId, "model.runtime_updated", details);
	}

	getModelConfig(agentRef: string): ModelConfig | undefined {
		return this.models.getModelConfig(agentRef);
	}

	setBuiltinModelConfig(
		agentRef: string,
		input: { provider: string; modelId: string; apiKey?: string; thinkingLevel?: AgentSpec["thinkingLevel"] },
	): AgentSpec {
		const agent = this.models.setBuiltinModelConfig(agentRef, input);
		this.audit(agent.agentId, "model.updated", { provider: input.provider, modelId: input.modelId, kind: "builtin" });
		return agent;
	}

	setCustomModelConfig(
		agentRef: string,
		input: {
			baseUrl: string;
			api: "openai-completions" | "anthropic-messages";
			providerId: string;
			modelId: string;
			apiKey?: string;
			thinkingLevel?: AgentSpec["thinkingLevel"];
		},
	): AgentSpec {
		const agent = this.models.setCustomModelConfig(agentRef, input);
		this.audit(agent.agentId, "model.updated", {
			baseUrl: input.baseUrl,
			api: input.api,
			providerId: input.providerId,
			modelId: input.modelId,
			kind: "custom",
		});
		return agent;
	}

	getProviderKey(agentId: string, provider: string): string | undefined {
		return this.models.getProviderKey(agentId, provider);
	}

	getCustomModelApiKey(agentId: string): string | undefined {
		return this.models.getCustomModelApiKey(agentId);
	}

	getRuntimeState(agentId: string): RuntimeState {
		return this.runtime.getRuntimeState(agentId);
	}

	writeRuntimeState(state: RuntimeState): void {
		this.runtime.writeRuntimeState(state);
	}

	getRuntimeProcessState(): RuntimeProcessState {
		return this.runtime.getRuntimeProcessState();
	}

	writeRuntimeProcessState(state: RuntimeProcessState, options?: { skipLock?: boolean }): void {
		this.runtime.writeRuntimeProcessState(state, options);
	}

	createRuntimeControlAction(
		action: Omit<RuntimeControlAction, "requestId" | "status" | "requestedAt" | "updatedAt">,
	): RuntimeControlAction {
		return this.runtime.createRuntimeControlAction(action);
	}

	getRuntimeControlAction(requestId: string): RuntimeControlAction | undefined {
		return this.runtime.getRuntimeControlAction(requestId);
	}

	listPendingRuntimeControlActions(): RuntimeControlAction[] {
		return this.runtime.listPendingRuntimeControlActions(NEKOCLAW_RUNTIME_CONTROL_DIR);
	}

	writeRuntimeControlAction(action: RuntimeControlAction): void {
		this.runtime.writeRuntimeControlAction(action);
	}

	deleteRuntimeControlAction(requestId: string): void {
		this.runtime.deleteRuntimeControlAction(requestId);
	}

	appendQueueEvent(agentId: string, event: QueueEvent): void {
		this.runtime.appendQueueEvent(agentId, event);
	}

	getQueueEvents(agentId: string): QueueEvent[] {
		return this.runtime.getQueueEvents(agentId);
	}

	rewriteQueueEvents(agentId: string, events: QueueEvent[]): void {
		this.runtime.rewriteQueueEvents(agentId, events);
	}

	recoverPendingJobs(agentId: string): RunJob[] {
		return this.runtime.recoverPendingJobs(agentId);
	}

	audit(agentId: string, kind: string, details: Record<string, unknown>): AuditEntry {
		return this.audits.audit(agentId, kind, details);
	}

	getAuditEntries(agentId: string): AuditEntry[] {
		return this.audits.getAuditEntries(agentId);
	}

	appendSessionLog(agentRef: string, sessionRecordId: string, value: unknown): void {
		this.sessions.appendSessionLog(agentRef, sessionRecordId, value);
	}
}
