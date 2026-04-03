import { join } from "node:path";
import type { ChannelPlugin } from "../types.js";
import { JsonNekoclawStore } from "../store/json-store.js";
import type {
	AgentSpec,
	ChannelToolAction,
	InboundMessageEvent,
	PairRequest,
	ReplyPayload,
	SessionRecord,
} from "../types.js";
import { getRuntimeKey } from "./runtime-key.js";
import { NEKOCLAW_CONTAINER_WORKSPACE_DIR } from "../config.js";
import { parseTargetRef } from "./runtime-directory.js";

export class OutboundDispatchService {
	constructor(
		private readonly store: JsonNekoclawStore,
		private readonly channelPlugins: Map<string, ChannelPlugin>,
	) {}

	private rebasePayload(agent: AgentSpec, payload: ReplyPayload): ReplyPayload {
		if (!payload.attachments?.length) {
			return payload;
		}

		const workspaceRoot = this.store.getWorkspaceRoot(agent.slug);
		const attachments = payload.attachments.map((attachment) => {
			const filePath = attachment.filePath;
			if (filePath && filePath.startsWith(NEKOCLAW_CONTAINER_WORKSPACE_DIR)) {
				const relativePath = filePath.slice(NEKOCLAW_CONTAINER_WORKSPACE_DIR.length).replace(/^[/\\]+/, "");
				return {
					...attachment,
					filePath: join(workspaceRoot, relativePath),
				};
			}
			return attachment;
		});

		return {
			...payload,
			attachments,
		};
	}

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

	async sendToSession(
		agent: AgentSpec,
		session: SessionRecord,
		event: InboundMessageEvent,
		payload: ReplyPayload,
	): Promise<void> {
		const channel = this.store.getChannel(agent.agentId, session.channelType);
		const plugin = this.channelPlugins.get(getRuntimeKey(agent, channel));
		if (!plugin) {
			throw new Error(`The ${channel.type} channel is not active for ${agent.slug}`);
		}
		const rebasedPayload = this.rebasePayload(agent, payload);
		await plugin.outbound.send({
			session,
			payload: rebasedPayload,
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
						payload: this.rebasePayload(agent, action.payload),
					});
					break;
				case "send_targeted": {
					const target = parseTargetRef(action.target);
					if (!target) {
						throw new Error(`Invalid send_message target: ${action.target}`);
					}
					const targetChannel = this.store.getChannel(agent.agentId, target.channelType);
					const targetPlugin = this.channelPlugins.get(getRuntimeKey(agent, targetChannel));
					if (!targetPlugin) {
						throw new Error(`The ${target.channelType} channel is not active for ${agent.slug}`);
					}
					await targetPlugin.actions.send({
						chatId: target.externalConversationId,
						chatKind: target.chatKind,
						payload: this.rebasePayload(agent, action.payload),
					});
					break;
				}
				case "reply":
					await plugin.actions.reply({
						chatId: session.externalConversationId,
						chatKind: session.chatKind,
						payload: this.rebasePayload(agent, action.payload),
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
				case "cron_create":
					this.store.createSessionCron(agent.agentId, session.sessionRecordId, {
						cronId: action.cronId,
						scheduleKind: action.scheduleKind,
						message: action.message,
						timezone: action.timezone,
						runAtLocal: action.runAtLocal,
						hour: action.hour,
						minute: action.minute,
					});
					break;
				case "cron_cancel":
					this.store.cancelSessionCron(agent.agentId, session.sessionRecordId, action.cronId);
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
