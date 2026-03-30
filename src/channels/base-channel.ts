import { isAddressedSlashCommand } from "../command-parsing.js";
import type {
	AgentSpec,
	ChannelCapabilities,
	ChannelMessageRef,
	ChannelReplyInput,
	ChannelSendInput,
	ChatKind,
	InboundMessageEvent,
	PairRequest,
	ReplyMode,
	ReplyPayload,
} from "../types.js";
import { getEventText } from "../messages.js";

export const DEFAULT_REPLY_MODE: Record<ChatKind, ReplyMode> = {
	dm: "off",
	group: "first",
};

export function isPairCommand(text: string): boolean {
	return /^\/pair(?:@[\w_]+)?$/i.test(text.trim());
}

export function createThreadingAdapter(replyModes: Partial<Record<ChatKind, ReplyMode>>) {
	return {
		resolveReplyMode: (chatKind: ChatKind): ReplyMode => replyModes[chatKind] ?? DEFAULT_REPLY_MODE[chatKind],
		applyReplyMode: (
			payload: ReplyPayload,
			input: { session: { chatKind: ChatKind }; event?: InboundMessageEvent },
		): ReplyPayload => {
			if (payload.replyToId) {
				return payload;
			}
			const mode = replyModes[input.session.chatKind] ?? DEFAULT_REPLY_MODE[input.session.chatKind];
			if (mode === "off") {
				return payload;
			}
			return {
				...payload,
				replyToId: input.event?.messageId,
			};
		},
	};
}

export function createOutboundAdapter(
	capabilities: ChannelCapabilities,
	actions: {
		send: (i: ChannelSendInput) => Promise<ChannelMessageRef[]>;
		reply: (i: ChannelReplyInput) => Promise<ChannelMessageRef[]>;
	},
	threading: ReturnType<typeof createThreadingAdapter>,
) {
	return {
		send: async (input: {
			session: { externalConversationId: string; chatKind: ChatKind };
			payload: ReplyPayload;
			event?: InboundMessageEvent;
		}): Promise<ChannelMessageRef[]> => {
			const payload = threading.applyReplyMode(input.payload, input);
			if (payload.replyToId && capabilities.reply) {
				return actions.reply({
					chatId: input.session.externalConversationId,
					chatKind: input.session.chatKind,
					payload,
					replyToId: payload.replyToId,
				});
			}
			return actions.send({
				chatId: input.session.externalConversationId,
				chatKind: input.session.chatKind,
				payload,
			});
		},
	};
}

export function createPairingAdapter() {
	return {
		shouldOfferPair: (event: InboundMessageEvent): boolean => {
			if (event.chatKind === "dm") {
				return true;
			}
			return isPairCommand(getEventText(event)) || isAddressedSlashCommand(event, "pair");
		},
		buildPairPrompt: (pair: PairRequest): ReplyPayload => ({
			text: `This chat is not paired yet.\nAsk an admin to run:\nnekoclaw pair accept --code ${pair.code}`,
		}),
		buildPairAccepted: (agent: AgentSpec): ReplyPayload => ({
			text: `${agent.slug} is now connected. You can start chatting.`,
		}),
		buildPairRejected: (): ReplyPayload => ({
			text: "Pairing was rejected by an admin.",
		}),
	};
}
