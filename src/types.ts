import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

export type ChannelType = "telegram" | "napcat";
export type ChatKind = "dm" | "group";
export type ModelApiFormat = "openai-completions" | "anthropic-messages";
export const NEKOCLAW_CONFIG_VERSION = 1;
export type MessageEventType = "message.created" | "message.updated" | "message.deleted";
export type ReplyMode = "off" | "first" | "all";
export type GroupTriggerMode = "all" | "mention";

export interface BuiltinModelConfig {
	kind: "builtin";
	provider: string;
	modelId: string;
	apiKey?: string;
	thinkingLevel?: ThinkingLevel;
}

export interface CustomModelConfig {
	kind: "custom";
	baseUrl: string;
	api: ModelApiFormat;
	providerId: string;
	modelId: string;
	apiKey?: string;
	thinkingLevel?: ThinkingLevel;
}

export type ModelConfig = BuiltinModelConfig | CustomModelConfig;

export interface TelegramChannelConfig {
	token?: string;
	groupTrigger?: GroupTriggerMode;
	replyMode?: {
		dm?: ReplyMode;
		group?: ReplyMode;
	};
	addedAt: string;
	updatedAt: string;
}

export interface NapcatChannelConfig {
	wsUrl?: string;
	accessToken?: string;
	selfId?: string;
	groupTrigger?: GroupTriggerMode;
	replyMode?: {
		dm?: ReplyMode;
		group?: ReplyMode;
	};
	addedAt: string;
	updatedAt: string;
}

export interface AdminIdentity {
	channelType: ChannelType;
	externalUserId: string;
	displayName?: string;
	addedAt: string;
}

export interface SessionModelOverride {
	provider: string;
	modelId: string;
	updatedAt: string;
}

export interface SessionLastRoute {
	channelType: ChannelType;
	externalConversationId: string;
	threadId?: string;
	updatedAt: string;
}

export interface SessionConfig {
	externalConversationId: string;
	channelType: ChannelType;
	chatKind: ChatKind;
	sessionKey: string;
	parentSessionKey?: string;
	threadId?: string;
	lastRoute?: SessionLastRoute;
	modelOverride?: SessionModelOverride;
	status: "active" | "removed";
	pairedAt: string;
	updatedAt: string;
}

export interface AgentConfig {
	agentId: string;
	image: string;
	enabled: boolean;
	model?: ModelConfig;
	channels: {
		telegram?: TelegramChannelConfig;
		napcat?: NapcatChannelConfig;
	};
	admins: AdminIdentity[];
	sessions: Record<string, SessionConfig>;
	lastError?: string;
	createdAt: string;
	updatedAt: string;
}

export interface PairingConfig {
	ttlMinutes: number;
	repromptCooldownSeconds: number;
}

export interface NekoclawConfig {
	version: typeof NEKOCLAW_CONFIG_VERSION;
	agents: Record<string, AgentConfig>;
	pairing: PairingConfig;
}

export interface AgentSpec {
	agentId: string;
	slug: string;
	image: string;
	containerName: string;
	enabled: boolean;
	provider?: string;
	modelId?: string;
	thinkingLevel?: ThinkingLevel;
	lastError?: string;
	createdAt: string;
	updatedAt: string;
}

export interface ChannelSpec {
	agentId: string;
	type: ChannelType;
	createdAt: string;
	updatedAt: string;
}

export interface SessionRecord {
	sessionRecordId: string;
	agentId: string;
	sessionKey: string;
	parentSessionKey?: string;
	channelType: ChannelType;
	externalConversationId: string;
	threadId?: string;
	chatKind: ChatKind;
	lastRoute?: SessionLastRoute;
	modelOverride?: SessionModelOverride;
	status: "active" | "removed";
	createdAt: string;
	updatedAt: string;
}

export interface PairRequest {
	pairingId: string;
	code: string;
	agentId: string;
	channelType: ChannelType;
	externalConversationId: string;
	chatKind: ChatKind;
	sessionKey: string;
	parentSessionKey?: string;
	threadId?: string;
	senderId?: string;
	senderName?: string;
	chatTitle?: string;
	status: "pending" | "accepted" | "rejected" | "expired";
	createdAt: string;
	expiresAt: string;
	lastPromptedAt?: string;
	updatedAt: string;
}

export interface AgentSecrets {
	channelTokens: Partial<Record<ChannelType, string>>;
	providerKeys: Record<string, string>;
	customModelApiKey?: string;
}

export interface RuntimeState {
	agentId: string;
	containerStatus?: string;
	currentJobId?: string;
	lastError?: string;
	updatedAt: string;
}

export interface RuntimeProcessState {
	pid?: number;
	updatedAt: string;
}

export interface RuntimeControlAction {
	requestId: string;
	kind: "agent.remove_runtime";
	status: "pending" | "completed" | "failed";
	agent: Pick<AgentSpec, "agentId" | "slug" | "containerName">;
	requestedAt: string;
	updatedAt: string;
	error?: string;
}

export interface AttachmentRef {
	kind: "image" | "file";
	name: string;
	relativePath: string;
	mimeType?: string;
	sizeBytes?: number;
}

export interface MessageSender {
	externalId?: string;
	displayName?: string;
}

export interface TextContentBlock {
	kind: "text";
	text: string;
}

export interface ImageContentBlock {
	kind: "image";
	remoteId?: string;
	name?: string;
	mimeType?: string;
	sizeBytes?: number;
	attachment?: AttachmentRef;
}

export interface FileContentBlock {
	kind: "file";
	remoteId?: string;
	name?: string;
	mimeType?: string;
	sizeBytes?: number;
	attachment?: AttachmentRef;
}

export type MessageContentBlock = TextContentBlock | ImageContentBlock | FileContentBlock;

export interface InboundMessageEvent {
	eventType: MessageEventType;
	channelType: ChannelType;
	chatId: string;
	chatKind: ChatKind;
	chatTitle?: string;
	messageId: string;
	replyToMessageId?: string;
	isReplyToBot?: boolean;
	mentionedUserIds?: string[];
	mentionedUsernames?: string[];
	sender: MessageSender;
	blocks: MessageContentBlock[];
	occurredAt: string;
}

export interface OutboundAttachment {
	kind: "image" | "file";
	filePath?: string;
	url?: string;
	name?: string;
	mimeType?: string;
}

export interface ReplyPayload {
	text?: string;
	attachments?: OutboundAttachment[];
	replyToId?: string;
	channelData?: Record<string, unknown>;
}

export interface ChannelCapabilities {
	text: boolean;
	media: boolean;
	reply: boolean;
	edit: boolean;
	delete: boolean;
	typing: boolean;
}

export interface ChannelMessageRef {
	chatId: string;
	messageId: string;
}

export interface ChannelHydrateEventInput {
	attachmentsDir: string;
	attachmentsRelativeDir: string;
}

export interface ChannelSessionAddress {
	channelType: ChannelType;
	externalConversationId: string;
	chatKind: ChatKind;
	threadId?: string;
	parentSessionKey?: string;
}

export interface ChannelPollCallbacks {
	onEvent: (event: InboundMessageEvent) => Promise<void> | void;
	onError?: (error: Error) => void;
	onHealthy?: () => void;
}

export interface ChannelSendInput {
	chatId: string;
	chatKind?: ChatKind;
	payload: ReplyPayload;
}

export interface ChannelReplyInput extends ChannelSendInput {
	replyToId: string;
}

export interface ChannelEditInput {
	chatId: string;
	messageId: string;
	text: string;
}

export interface ChannelDeleteInput {
	chatId: string;
	messageId: string;
}

export interface ChannelTypingInput {
	chatId: string;
}

export interface ChannelOutboundInput {
	session: SessionRecord;
	payload: ReplyPayload;
	event?: InboundMessageEvent;
}

export interface ChannelMessageActionAdapter {
	send(input: ChannelSendInput): Promise<ChannelMessageRef[]>;
	reply(input: ChannelReplyInput): Promise<ChannelMessageRef[]>;
	edit(input: ChannelEditInput): Promise<void>;
	delete(input: ChannelDeleteInput): Promise<void>;
	typing(input: ChannelTypingInput): Promise<void>;
}

export interface ChannelOutboundAdapter {
	send(input: ChannelOutboundInput): Promise<ChannelMessageRef[]>;
}

export interface ChannelThreadingAdapter {
	resolveReplyMode(chatKind: ChatKind): ReplyMode;
	applyReplyMode(payload: ReplyPayload, input: ChannelOutboundInput): ReplyPayload;
}

export interface ChannelPairingAdapter {
	shouldOfferPair(event: InboundMessageEvent): boolean;
	buildPairPrompt(pair: PairRequest): ReplyPayload;
	buildPairAccepted(agent: AgentSpec): ReplyPayload;
	buildPairRejected(pair: PairRequest): ReplyPayload;
}

export interface ChannelTriggeringAdapter {
	shouldProcessEvent(event: InboundMessageEvent): boolean;
}

export interface ChannelToolContext {
	session: SessionRecord;
	event: InboundMessageEvent;
	capabilities: ChannelCapabilities;
	runtimeDirectory: RuntimeDirectorySnapshot;
	isExplicitlyAddressed?: boolean;
	recordAction: (action: ChannelToolAction) => void;
}

export interface ChannelToolFactory {
	createTools(context: ChannelToolContext): ToolDefinition[];
}

export interface ChannelBotIdentity {
	username?: string;
	userId?: string;
}

export interface ChannelPlugin {
	readonly type: ChannelType;
	readonly capabilities: ChannelCapabilities;
	readonly botIdentity?: ChannelBotIdentity;
	readonly outbound: ChannelOutboundAdapter;
	readonly actions: ChannelMessageActionAdapter;
	readonly threading: ChannelThreadingAdapter;
	readonly pairing: ChannelPairingAdapter;
	readonly triggering: ChannelTriggeringAdapter;
	readonly channelTools?: ChannelToolFactory;
	resolveSessionAddress(event: InboundMessageEvent): ChannelSessionAddress;
	startPolling(callbacks: ChannelPollCallbacks): void;
	stop(): void;
	hydrateInboundEvent?(event: InboundMessageEvent, input: ChannelHydrateEventInput): Promise<InboundMessageEvent>;
}

export type ChannelToolAction =
	| {
			kind: "send";
			payload: ReplyPayload;
	  }
	| {
			kind: "send_targeted";
			target: string;
			payload: ReplyPayload;
	  }
	| {
			kind: "reply";
			payload: ReplyPayload;
			replyToId?: string;
	  }
	| {
			kind: "edit";
			messageId: string;
			text: string;
	  }
	| {
			kind: "delete";
			messageId: string;
	  }
	| {
			kind: "typing";
	  }
	| {
			kind: "no_reply";
	  };

export interface RunJob {
	jobId: string;
	agentId: string;
	kind: "inbound";
	sessionRecordId: string;
	sessionKey: string;
	createdAt: string;
	event: InboundMessageEvent;
}

export interface QueueEvent {
	type: "enqueue" | "start" | "complete" | "fail";
	jobId: string;
	timestamp: string;
	job?: RunJob;
	error?: string;
}

export interface PreparedPersonaMemoryDocument {
	path: string;
	content: string;
}

export interface PreparedPersonaContext {
	indexMarkdown: string;
	sceneObservations: string;
	selectedMemories: PreparedPersonaMemoryDocument[];
	selectionNotes: string;
}

export interface RuntimeDirectoryContactSnapshot {
	account: string;
	displayName?: string;
	channel: "telegram" | "qq";
	lastSeenAt: string;
	pairedSessionKey?: string;
	sourceHints: string[];
}

export interface RuntimeDirectoryGroupSnapshot {
	groupRef: string;
	title?: string;
	channel: "telegram" | "qq";
	lastSeenAt: string;
	pairedSessionKey?: string;
}

export interface RuntimeDirectoryGroupMemberSnapshot {
	account: string;
	displayName?: string;
	lastSeenAt: string;
	source: "runtime_seen" | "napcat_live";
}

export interface RuntimeDirectorySnapshot {
	contacts: RuntimeDirectoryContactSnapshot[];
	groups: RuntimeDirectoryGroupSnapshot[];
	groupMembers: Record<string, RuntimeDirectoryGroupMemberSnapshot[]>;
	availableChannels: Array<"telegram" | "qq">;
}

export interface WorkerPayload {
	agent: AgentSpec;
	job: RunJob;
	currentSession: SessionRecord;
	capabilities: ChannelCapabilities;
	runtimeDirectory: RuntimeDirectorySnapshot;
	personaContext?: PreparedPersonaContext;
	selfIdentity?: {
		telegramHandles?: string[];
		platformUserId?: string;
		isExplicitlyAddressed?: boolean;
	};
	effectiveModel?: {
		provider: string;
		modelId: string;
		thinkingLevel?: ThinkingLevel;
	};
}

export interface WorkerResult {
	outbound: ReplyPayload;
	toolActions?: ChannelToolAction[];
	stopReason?: string;
	errorMessage?: string;
}

export interface ProxyProbeResult {
	api: ModelApiFormat;
	baseUrl: string;
	modelId: string;
	modelsCheckOk: boolean;
	generationCheckOk: boolean;
	details: string[];
}

export interface AuditEntry {
	timestamp: string;
	kind: string;
	agentId: string;
	details: Record<string, unknown>;
}
