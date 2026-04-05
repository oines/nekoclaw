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
import { nowIso } from "../store/helpers.js";
import { buildBotOutboundSessionLogEntry, type BotOutboundLogSource } from "./session-log.js";

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
		const refs = await plugin.outbound.send({
			session,
			payload: rebasedPayload,
			event,
		});
		this.appendBotOutboundLog(agent, {
			session,
			payload,
			source: "outbound",
			chatTitle: event.chatTitle ?? session.chatTitle,
			messageIds: refs.map((ref) => ref.messageId),
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
					this.appendBotOutboundLog(agent, {
						session,
						payload: action.payload,
						source: "tool.send",
						messageIds: (
							await plugin.actions.send({
								chatId: session.externalConversationId,
								chatKind: session.chatKind,
								payload: this.rebasePayload(agent, action.payload),
							})
						).map((ref) => ref.messageId),
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
					const refs = await targetPlugin.actions.send({
						chatId: target.externalConversationId,
						chatKind: target.chatKind,
						payload: this.rebasePayload(agent, action.payload),
					});
					const targetSession = this.store.findSessionByAddress(agent.agentId, {
						channelType: target.channelType,
						externalConversationId: target.externalConversationId,
						chatKind: target.chatKind,
					});
					if (targetSession) {
						this.appendBotOutboundLog(agent, {
							session: targetSession,
							payload: action.payload,
							source: "tool.send_targeted",
							messageIds: refs.map((ref) => ref.messageId),
						});
					}
					break;
				}
				case "reply":
					this.appendBotOutboundLog(agent, {
						session,
						payload: action.payload,
						source: "tool.reply",
						messageIds: (
							await plugin.actions.reply({
								chatId: session.externalConversationId,
								chatKind: session.chatKind,
								payload: this.rebasePayload(agent, action.payload),
								replyToId: action.replyToId ?? action.payload.replyToId ?? "",
							})
						).map((ref) => ref.messageId),
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

	private appendBotOutboundLog(
		agent: AgentSpec,
		input: {
			session: SessionRecord;
			payload: ReplyPayload;
			source: BotOutboundLogSource;
			chatTitle?: string;
			messageIds?: string[];
		},
	): void {
		this.store.services.sessions.appendSessionLog(
			agent.agentId,
			input.session.sessionRecordId,
			buildBotOutboundSessionLogEntry({
				timestamp: nowIso(),
				session: {
					sessionRecordId: input.session.sessionRecordId,
					channelType: input.session.channelType,
					externalConversationId: input.session.externalConversationId,
					chatKind: input.session.chatKind,
					chatTitle: input.chatTitle ?? input.session.chatTitle,
				},
				payload: input.payload,
				source: input.source,
				messageIds: input.messageIds,
			}),
		);
	}
}
