import type { ChannelPlugin } from "../types.js";
import { JsonNekoclawStore } from "../store/json-store.js";
import type { AgentSpec, ChannelToolAction, InboundMessageEvent, PairRequest, ReplyPayload, SessionRecord } from "../types.js";
import { getRuntimeKey } from "./runtime-key.js";

export class OutboundDispatchService {
	constructor(
		private readonly store: JsonNekoclawStore,
		private readonly channelPlugins: Map<string, ChannelPlugin>,
	) {}

	async sendPairAcceptedMessage(pair: PairRequest): Promise<void> {
		const agent = this.store.getAgentByRef(pair.agentId);
		const channel = this.store.getChannel(agent.agentId, pair.channelType);
		const plugin = this.channelPlugins.get(getRuntimeKey(agent, channel));
		if (!plugin) {
			return;
		}
		await plugin.actions.send({
			chatId: pair.externalConversationId,
			chatKind: pair.chatKind,
			payload: plugin.pairing.buildPairAccepted(agent),
		});
	}

	async sendPairRejectedMessage(pair: PairRequest): Promise<void> {
		const agent = this.store.getAgentByRef(pair.agentId);
		const channel = this.store.getChannel(agent.agentId, pair.channelType);
		const plugin = this.channelPlugins.get(getRuntimeKey(agent, channel));
		if (!plugin) {
			return;
		}
		await plugin.actions.send({
			chatId: pair.externalConversationId,
			chatKind: pair.chatKind,
			payload: plugin.pairing.buildPairRejected(pair),
		});
	}

	async sendToSession(agent: AgentSpec, session: SessionRecord, event: InboundMessageEvent, payload: ReplyPayload): Promise<void> {
		const channel = this.store.getChannel(agent.agentId, session.channelType);
		const plugin = this.channelPlugins.get(getRuntimeKey(agent, channel));
		if (!plugin) {
			throw new Error(`The ${channel.type} channel is not active for ${agent.slug}`);
		}
		await plugin.outbound.send({
			session,
			payload,
			event,
		});
		this.store.audit(agent.agentId, `${channel.type}.outbound`, {
			sessionRecordId: session.sessionRecordId,
			sessionKey: session.sessionKey,
			textLength: payload.text?.length ?? 0,
			attachmentCount: payload.attachments?.length ?? 0,
		});
	}

	async executeToolActions(agent: AgentSpec, session: SessionRecord, actions: ChannelToolAction[]): Promise<void> {
		const channel = this.store.getChannel(agent.agentId, session.channelType);
		const plugin = this.channelPlugins.get(getRuntimeKey(agent, channel));
		if (!plugin) {
			throw new Error(`The ${channel.type} channel is not active for ${agent.slug}`);
		}
		for (const action of actions) {
			switch (action.kind) {
				case "send":
					await plugin.actions.send({
						chatId: session.externalConversationId,
						chatKind: session.chatKind,
						payload: action.payload,
					});
					break;
				case "reply":
					await plugin.actions.reply({
						chatId: session.externalConversationId,
						chatKind: session.chatKind,
						payload: action.payload,
						replyToId: action.replyToId ?? action.payload.replyToId ?? "",
					});
					break;
				case "edit":
					await plugin.actions.edit({
						chatId: session.externalConversationId,
						messageId: action.messageId,
						text: action.text,
					});
					break;
				case "delete":
					await plugin.actions.delete({
						chatId: session.externalConversationId,
						messageId: action.messageId,
					});
					break;
				case "typing":
					await plugin.actions.typing({ chatId: session.externalConversationId });
					break;
				case "no_reply":
					break;
			}
		}
		this.store.audit(agent.agentId, `${channel.type}.tool_actions`, {
			sessionRecordId: session.sessionRecordId,
			sessionKey: session.sessionKey,
			actionCount: actions.length,
			actions: actions.map((action) => action.kind),
		});
	}
}
