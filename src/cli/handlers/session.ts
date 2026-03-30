import chalk from "chalk";
import { JsonNekoclawStore } from "../../store/json-store.js";
import { requireValue, type PurgeOptions } from "./shared.js";

export async function handleSessionList(agentRef: string, store: JsonNekoclawStore): Promise<void> {
	const sessions = store.listSessions(store.getAgentByRef(requireValue(agentRef, "agent")).agentId);
	if (sessions.length === 0) {
		console.log("No sessions paired yet.");
		return;
	}
	console.log("CONVERSATION\tTYPE\tSESSION KEY\tPAIRED AT\tSTATUS");
	for (const session of sessions) {
		console.log(`${session.externalConversationId}\t${session.chatKind}\t${session.sessionKey}\t${session.createdAt}\t${session.status}`);
	}
}

export async function handleSessionRemove(agentRef: string, sessionRef: string, options: PurgeOptions, store: JsonNekoclawStore): Promise<void> {
	const session = store.removeSession(requireValue(agentRef, "agent"), requireValue(sessionRef, "session"), {
		purge: Boolean(options.purge),
	});
	console.log(chalk.green(`Removed session ${session.externalConversationId}`));
}
