import type {
	AgentSpec,
	AdminIdentity,
	AuditEntry,
	ChannelSessionAddress,
	ChannelSpec,
	ChannelType,
	ChatKind,
	ModelApiFormat,
	ModelConfig,
	PairRequest,
	PairingConfig,
	QueueEvent,
	RunJob,
	RuntimeControlAction,
	RuntimeProcessState,
	RuntimeState,
	SessionCronRecord,
	SessionRecord,
} from "../types.js";
import { AgentStore, type CreateAgentInput, type UpdateAgentInput } from "./agent-store.js";
import { AuditStore } from "./audit-store.js";
import { ChannelStore } from "./channel-store.js";
import { ConfigRepository } from "./config-repository.js";
import { CronStore } from "./cron-store.js";
import { ModelStore } from "./model-store.js";
import { PairStore } from "./pair-store.js";
import { StorePaths } from "./paths.js";
import { RuntimeStateStore } from "./runtime-state-store.js";
import {
	AgentLifecycleService,
	ChannelLifecycleService,
	ContentService,
	CronLifecycleService,
	PairingService,
	RuntimeControlStoreService,
	SessionLifecycleService,
} from "./services/index.js";
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

	private readonly crons = new CronStore(this.paths);

	private readonly sessionLifecycle = new SessionLifecycleService(this.sessions, this.crons, this.audits);

	readonly services = {
		agents: new AgentLifecycleService(
			this.agents,
			this.channels,
			this.sessions,
			this.sessionLifecycle,
			this.crons,
			this.pairs,
			this.runtime,
			this.audits,
		),
		channels: new ChannelLifecycleService(this.agents, this.channels, this.sessions, this.sessionLifecycle, this.audits),
		sessions: this.sessionLifecycle,
		pairing: new PairingService(this.agents, this.sessions, this.sessionLifecycle, this.pairs, this.audits),
		crons: new CronLifecycleService(this.sessions, this.crons, this.audits),
		content: new ContentService(this.agents, this.models, this.audits),
		runtime: new RuntimeControlStoreService(this.runtime),
	};

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

	getCronPath(cronId: string): string {
		return this.paths.getCronPath(cronId);
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
		return this.services.agents.createAgent(input);
	}

	updateAgent(ref: string, patch: UpdateAgentInput): AgentSpec {
		return this.services.agents.updateAgent(ref, patch);
	}

	deleteAgent(ref: string, options?: { force?: boolean }): AgentSpec {
		return this.services.agents.deleteAgent(ref, options);
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
		return this.services.channels.createChannel(agentRef, type);
	}

	removeChannel(agentRef: string, type: ChannelType, options?: { force?: boolean }): ChannelSpec {
		return this.services.channels.removeChannel(agentRef, type, options);
	}

	setChannelToken(agentRef: string, type: ChannelType, token: string): void {
		this.services.channels.setChannelToken(agentRef, type, token);
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
		this.services.channels.setNapcatEndpoint(agentRef, input);
	}

	setChannelGroupTrigger(agentRef: string, type: ChannelType, groupTrigger: "all" | "mention"): void {
		this.services.channels.setChannelGroupTrigger(agentRef, type, groupTrigger);
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
			chatTitle?: string;
			threadId?: string;
			parentSessionKey?: string;
			sessionKey?: string;
		},
	): SessionRecord {
		return this.services.sessions.createSession(agentRef, input);
	}

	updateSessionLastRoute(
		agentRef: string,
		sessionRef: string,
		input: { externalConversationId: string; threadId?: string },
	): SessionRecord {
		return this.services.sessions.updateSessionLastRoute(agentRef, sessionRef, input);
	}

	updateSessionChatTitle(agentRef: string, sessionRef: string, chatTitle: string): SessionRecord {
		return this.services.sessions.updateSessionChatTitle(agentRef, sessionRef, chatTitle);
	}

	setSessionModelOverride(
		agentRef: string,
		sessionRef: string,
		input: { provider: string; modelId: string },
	): SessionRecord {
		return this.services.sessions.setSessionModelOverride(agentRef, sessionRef, input);
	}

	clearSessionModelOverride(agentRef: string, sessionRef: string): SessionRecord {
		return this.services.sessions.clearSessionModelOverride(agentRef, sessionRef);
	}

	resetSession(agentRef: string, sessionRef: string): SessionRecord {
		return this.services.sessions.resetSession(agentRef, sessionRef);
	}

	removeSession(agentRef: string, ref: string, options?: { purge?: boolean }): SessionRecord {
		return this.services.sessions.removeSession(agentRef, ref, options);
	}

	listActiveSessionCrons(agentRef: string, sessionRef: string): SessionCronRecord[] {
		const session = this.getSession(agentRef, sessionRef);
		return this.crons.listActiveSessionCrons(session.agentId, session.sessionRecordId);
	}

	createSessionCron(
		agentRef: string,
		sessionRef: string,
		input: {
			cronId?: string;
			scheduleKind: SessionCronRecord["scheduleKind"];
			message: string;
			timezone?: string;
			runAtLocal?: string;
			hour?: number;
			minute?: number;
		},
	): SessionCronRecord {
		return this.services.crons.createSessionCron(agentRef, sessionRef, input);
	}

	cancelSessionCron(agentRef: string, sessionRef: string, cronId: string): SessionCronRecord {
		return this.services.crons.cancelSessionCron(agentRef, sessionRef, cronId);
	}

	listDueCrons(at?: Date): SessionCronRecord[] {
		return this.crons.listDueCrons(at);
	}

	completeCron(cronId: string, triggeredAt: string): SessionCronRecord {
		return this.services.crons.completeCron(cronId, triggeredAt);
	}

	advanceDailyCron(cronId: string, triggeredAt: string): SessionCronRecord {
		return this.services.crons.advanceDailyCron(cronId, triggeredAt);
	}

	invalidateCron(cronId: string, reason?: string): SessionCronRecord {
		return this.services.crons.invalidateCron(cronId, reason);
	}

	getCron(cronId: string): SessionCronRecord | undefined {
		return this.crons.getCron(cronId);
	}

	getDefaultCronTimezone(): string {
		return this.crons.getDefaultTimezone();
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
		return this.services.pairing.createOrReusePair(agentRef, input);
	}

	touchPairPrompt(pairingId: string): PairRequest {
		return this.services.pairing.touchPairPrompt(pairingId);
	}

	getPairByCode(code: string): PairRequest {
		return this.services.pairing.getPairByCode(code);
	}

	acceptPair(code: string): { pair: PairRequest; session: SessionRecord } {
		return this.services.pairing.acceptPair(code);
	}

	rejectPair(code: string): PairRequest {
		return this.services.pairing.rejectPair(code);
	}

	deletePairRequestsForAgent(agentId: string): void {
		this.services.pairing.deletePairRequestsForAgent(agentId);
	}

	readSoul(agentRef: string): string {
		return this.services.content.readSoul(agentRef);
	}

	readAgents(agentRef: string): string {
		return this.services.content.readAgents(agentRef);
	}

	writeSoul(agentRef: string, content: string): void {
		this.services.content.writeSoul(agentRef, content);
	}

	readMemory(agentRef: string): string {
		return this.services.content.readMemory(agentRef);
	}

	writeMemory(agentRef: string, content: string): void {
		this.services.content.writeMemory(agentRef, content);
	}

	readRuntimeModelsConfig(agentRef: string): Record<string, unknown> | undefined {
		return this.services.content.readRuntimeModelsConfig(agentRef);
	}

	writeRuntimeModelsConfig(agentRef: string, config: Record<string, unknown>, details: Record<string, unknown>): void {
		this.services.content.writeRuntimeModelsConfig(agentRef, config, details);
	}

	getModelConfig(agentRef: string): ModelConfig | undefined {
		return this.services.content.getModelConfig(agentRef);
	}

	setBuiltinModelConfig(
		agentRef: string,
		input: { provider: string; modelId: string; apiKey?: string; thinkingLevel?: AgentSpec["thinkingLevel"] },
	): AgentSpec {
		return this.services.content.setBuiltinModelConfig(agentRef, input);
	}

	setCustomModelConfig(
		agentRef: string,
		input: {
			baseUrl: string;
			api: ModelApiFormat;
			providerId: string;
			modelId: string;
			apiKey?: string;
			thinkingLevel?: AgentSpec["thinkingLevel"];
		},
	): AgentSpec {
		return this.services.content.setCustomModelConfig(agentRef, input);
	}

	getProviderKey(agentId: string, provider: string): string | undefined {
		return this.models.getProviderKey(agentId, provider);
	}

	getCustomModelApiKey(agentId: string): string | undefined {
		return this.models.getCustomModelApiKey(agentId);
	}

	getRuntimeState(agentId: string): RuntimeState {
		return this.services.runtime.getRuntimeState(agentId);
	}

	writeRuntimeState(state: RuntimeState): void {
		this.services.runtime.writeRuntimeState(state);
	}

	getRuntimeProcessState(): RuntimeProcessState {
		return this.services.runtime.getRuntimeProcessState();
	}

	writeRuntimeProcessState(state: RuntimeProcessState, options?: { skipLock?: boolean }): void {
		this.services.runtime.writeRuntimeProcessState(state, options);
	}

	createRuntimeControlAction(
		action: Omit<RuntimeControlAction, "requestId" | "status" | "requestedAt" | "updatedAt">,
	): RuntimeControlAction {
		return this.services.runtime.createRuntimeControlAction(action);
	}

	getRuntimeControlAction(requestId: string): RuntimeControlAction | undefined {
		return this.services.runtime.getRuntimeControlAction(requestId);
	}

	listPendingRuntimeControlActions(): RuntimeControlAction[] {
		return this.services.runtime.listPendingRuntimeControlActions();
	}

	writeRuntimeControlAction(action: RuntimeControlAction): void {
		this.services.runtime.writeRuntimeControlAction(action);
	}

	deleteRuntimeControlAction(requestId: string): void {
		this.services.runtime.deleteRuntimeControlAction(requestId);
	}

	appendQueueEvent(agentId: string, event: QueueEvent): void {
		this.services.runtime.appendQueueEvent(agentId, event);
	}

	getQueueEvents(agentId: string): QueueEvent[] {
		return this.services.runtime.getQueueEvents(agentId);
	}

	rewriteQueueEvents(agentId: string, events: QueueEvent[]): void {
		this.services.runtime.rewriteQueueEvents(agentId, events);
	}

	recoverPendingJobs(agentId: string): RunJob[] {
		return this.services.runtime.recoverPendingJobs(agentId);
	}

	audit(agentId: string, kind: string, details: Record<string, unknown>): AuditEntry {
		return this.audits.audit(agentId, kind, details);
	}

	getAuditEntries(agentId: string): AuditEntry[] {
		return this.audits.getAuditEntries(agentId);
	}

	appendSessionLog(agentRef: string, sessionRecordId: string, value: unknown): void {
		this.services.sessions.appendSessionLog(agentRef, sessionRecordId, value);
	}
}
