import crypto from "node:crypto";
import { JsonNekoclawStore } from "../store/json-store.js";
import type { ChannelPlugin, ChannelSessionAddress, ChannelType, InboundMessageEvent, PairRequest } from "../types.js";
import { nowIso } from "../store/helpers.js";
import { CommandRouterService } from "./command-router.js";
import { isRuntimeBackpressureError } from "./errors.js";
import { getRuntimeKey } from "./runtime-key.js";

function shouldSuppressReprompt(pair: PairRequest, cooldownSeconds: number): boolean {
	if (!pair.lastPromptedAt) {
		return false;
	}
	return Date.now() - new Date(pair.lastPromptedAt).getTime() < cooldownSeconds * 1_000;
}

const BUSY_MESSAGE = "I'm busy right now. Please try again in a moment.";

export class MessageRouterService {
	constructor(
		private readonly store: JsonNekoclawStore,
		private readonly channelPlugins: Map<string, ChannelPlugin>,
		private readonly commands: CommandRouterService,
		private readonly enqueue: (job: {
			jobId: string;
			agentId: string;
			kind: "inbound";
			sessionRecordId: string;
			sessionKey: string;
			createdAt: string;
			event: InboundMessageEvent;
		}) => Promise<void>,
	) {}

	async handleInbound(agentId: string, channelType: ChannelType, event: InboundMessageEvent): Promise<void> {
		const agent = this.store.getAgentByRef(agentId);
		const channel = this.store.getChannel(agent.agentId, channelType);
		const plugin = this.channelPlugins.get(getRuntimeKey(agent.agentId, channel.type));
		const sessionAddress = plugin?.resolveSessionAddress(event) ?? {
			channelType: channel.type,
			externalConversationId: event.chatId,
			chatKind: event.chatKind,
		};
		const session = this.store.findSessionByAddress(agent.agentId, sessionAddress);
		const canProcessNormally = plugin?.triggering.shouldProcessEvent(event) ?? true;
		if (plugin && canProcessNormally && (await this.commands.handleCommand(agent, plugin, event, session))) {
			return;
		}
		if (plugin && !canProcessNormally) {
			this.store.audit(agent.agentId, `${channel.type}.ignored`, {
				chatId: event.chatId,
				messageId: event.messageId,
				reason: "group_trigger",
			});
			return;
		}
		if (!session) {
			await this.handleUnpairedMessage(agent.agentId, channel.type, event, sessionAddress);
			return;
		}

		const hydratedEvent =
			plugin?.hydrateInboundEvent
				? await plugin.hydrateInboundEvent(event, {
						attachmentsDir: this.store.getSessionAttachmentsDir(agent.slug, session.sessionRecordId),
						attachmentsRelativeDir: `chats/${session.sessionRecordId}/attachments`,
					})
				: event;

		this.store.updateSessionLastRoute(agent.agentId, session.sessionRecordId, {
			externalConversationId: sessionAddress.externalConversationId,
			threadId: sessionAddress.threadId,
		});
		this.store.appendSessionLog(agent.agentId, session.sessionRecordId, {
			timestamp: nowIso(),
			type: hydratedEvent.eventType,
			channel: channel.type,
			...hydratedEvent,
		});
		this.store.audit(agent.agentId, `${channel.type}.inbound`, {
			sessionRecordId: session.sessionRecordId,
			sessionKey: session.sessionKey,
			chatId: session.externalConversationId,
			messageId: hydratedEvent.messageId,
			eventType: hydratedEvent.eventType,
		});
		try {
			await this.enqueue({
				jobId: crypto.randomUUID(),
				agentId: agent.agentId,
				kind: "inbound",
				sessionRecordId: session.sessionRecordId,
				sessionKey: session.sessionKey,
				createdAt: nowIso(),
				event: hydratedEvent,
			});
		} catch (error) {
			if (plugin && isRuntimeBackpressureError(error)) {
				await plugin.actions.send({
					chatId: sessionAddress.externalConversationId,
					chatKind: sessionAddress.chatKind,
					payload: { text: BUSY_MESSAGE },
				});
				return;
			}
			throw error;
		}
	}

	private async handleUnpairedMessage(
		agentId: string,
		channelType: ChannelType,
		event: InboundMessageEvent,
		sessionAddress: ChannelSessionAddress,
	): Promise<void> {
		const agent = this.store.getAgentByRef(agentId);
		const channel = this.store.getChannel(agent.agentId, channelType);
		const plugin = this.channelPlugins.get(getRuntimeKey(agent.agentId, channel.type));
		if (!plugin) {
			return;
		}
		if (!plugin.pairing.shouldOfferPair(event)) {
			this.store.audit(agent.agentId, "pair.ignored", {
				channel: channel.type,
				chatId: event.chatId,
				reason: "not_pair_trigger",
			});
			return;
		}
		const pair = this.store.createOrReusePair(agent.agentId, {
			channelType: channel.type,
			externalConversationId: sessionAddress.externalConversationId,
			chatKind: sessionAddress.chatKind,
			threadId: sessionAddress.threadId,
			parentSessionKey: sessionAddress.parentSessionKey,
			sessionKey: this.store.resolveSessionKey(agent.agentId, sessionAddress),
			senderId: event.sender.externalId,
			senderName: event.sender.displayName,
			chatTitle: event.chatTitle,
		});
		if (shouldSuppressReprompt(pair, this.store.getPairingConfig().repromptCooldownSeconds)) {
			this.store.audit(agent.agentId, "pair.reprompt_suppressed", {
				code: pair.code,
				channel: channel.type,
				chatId: pair.externalConversationId,
			});
			return;
		}
		await plugin.actions.send({
			chatId: pair.externalConversationId,
			chatKind: pair.chatKind,
			payload: plugin.pairing.buildPairPrompt(pair),
		});
		this.store.touchPairPrompt(pair.pairingId);
		this.store.audit(agent.agentId, "pair.prompted", {
			code: pair.code,
			channel: channel.type,
			chatKind: pair.chatKind,
		});
	}
}
