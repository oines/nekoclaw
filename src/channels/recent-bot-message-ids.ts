import type { ChannelMessageRef } from "../types.js";

const MAX_TRACKED_CHATS = 200;
const MAX_TRACKED_MESSAGE_IDS_PER_CHAT = 100;

export class RecentBotMessageIds {
	private readonly idsByChat = new Map<string, string[]>();

	note(chatId: string, refs: ChannelMessageRef[]): void {
		if (refs.length === 0) {
			return;
		}
		const existing = this.idsByChat.get(chatId) ?? [];
		const merged = [...existing];
		for (const ref of refs) {
			const messageId = ref.messageId?.trim();
			if (!messageId) {
				continue;
			}
			if (merged.includes(messageId)) {
				continue;
			}
			merged.push(messageId);
		}
		const trimmed = merged.slice(-MAX_TRACKED_MESSAGE_IDS_PER_CHAT);
		this.idsByChat.delete(chatId);
		this.idsByChat.set(chatId, trimmed);
		while (this.idsByChat.size > MAX_TRACKED_CHATS) {
			const oldestChatId = this.idsByChat.keys().next().value;
			if (!oldestChatId) {
				break;
			}
			this.idsByChat.delete(oldestChatId);
		}
	}

	isReplyToBot(chatId: string, replyToMessageId?: string): boolean {
		if (!replyToMessageId) {
			return false;
		}
		return this.idsByChat.get(chatId)?.includes(replyToMessageId) ?? false;
	}
}
