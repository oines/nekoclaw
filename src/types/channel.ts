import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { AgentSpec, PairRequest } from "./agent.js";
import type { ChannelSpec } from "./channel-config.js";
import type { ChannelType, ChatKind, ReplyMode } from "./common.js";
import type { InboundMessageEvent, ReplyPayload, ChannelToolAction } from "./message.js";
import type { RuntimeDirectorySnapshot } from "./runtime.js";
import type { ChannelSessionAddress, SessionCronRecord, SessionRecord } from "./session.js";

export interface ChannelCapabilities {
	text: boolean;
	media: boolean;
	reply: true | false;
	edit: true | false;
	delete: true | false;
	typing: true | false;
}

export interface ChannelMessageRef {
	chatId: string;
	messageId: string;
}

export interface ChannelHydrateEventInput {
	attachmentsDir: string;
	attachmentsRelativeDir: string;
}

export interface ChannelPollCallbacks {
	onEvent: (event: InboundMessageEvent) => Promise<void> | void;
	onError?: (error: Error) => void;
	onHealthy?: () => void;
	onGroupTitles?: (titles: Array<{ chatId: string; title: string }>) => void;
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
	serverTimezone: string;
	sessionCrons: SessionCronRecord[];
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

export type { ChannelSpec };
