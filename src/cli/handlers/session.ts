import chalk from "chalk";
import { JsonNekoclawStore } from "../../store/json-store.js";
import { requireValue, type PurgeOptions } from "./shared.js";

import Table from "cli-table3";

export async function handleSessionList(agentRef: string, store: JsonNekoclawStore): Promise<void> {
	const sessions = store.listSessions(store.getAgentByRef(requireValue(agentRef, "agent")).agentId);
	if (sessions.length === 0) {
		console.log("No sessions paired yet.");
		return;
	}
	const table = new Table({
		head: ["CONVERSATION", "TYPE", "SESSION KEY", "PAIRED AT", "STATUS"].map((h) => chalk.bold(h)),
		chars: { mid: "", "left-mid": "", "mid-mid": "", "right-mid": "" },
	});
	for (const session of sessions) {
		table.push([
			session.externalConversationId,
			session.chatKind,
			session.sessionKey,
			session.createdAt,
			session.status,
		]);
	}
	console.log(table.toString());
}

export async function handleSessionRemove(agentRef: string, sessionRef: string, options: PurgeOptions, store: JsonNekoclawStore): Promise<void> {
	const session = store.removeSession(requireValue(agentRef, "agent"), requireValue(sessionRef, "session"), {
		purge: Boolean(options.purge),
	});
	console.log(chalk.green(`Removed session ${session.externalConversationId}`));
}
