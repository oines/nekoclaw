import chalk from "chalk";
import { JsonNekoclawStore } from "../../store/json-store.js";
import type { PairCodeOptions, PairListOptions } from "./shared.js";
import { requireValue } from "./shared.js";
import { directSendToChannel } from "./channel.js";

export async function handlePairList(options: PairListOptions, store: JsonNekoclawStore): Promise<void> {
	const agentId = options.agent ? store.getAgentByRef(options.agent).agentId : undefined;
	const pairs = store.listPairRequests(agentId);
	if (pairs.length === 0) {
		console.log("No pending pair requests.");
		return;
	}
	console.log("CODE\tAGENT\tCHANNEL\tTYPE\tFROM\tSTATUS");
	for (const pair of pairs) {
		const agent = store.getAgentByRef(pair.agentId);
		console.log(`${pair.code}\t${agent.slug}\t${pair.channelType}\t${pair.chatKind}\t${pair.senderName ?? "-"}\t${pair.status}`);
	}
}

export async function handlePairAccept(options: PairCodeOptions, store: JsonNekoclawStore): Promise<void> {
	const { pair, session } = store.acceptPair(requireValue(options.code, "pairing code"));
	await directSendToChannel(store, pair, `${store.getAgentByRef(pair.agentId).slug} is now connected. You can start chatting.`);
	console.log(chalk.green("Pairing accepted"));
	console.log(`Session is now connected to ${store.getAgentByRef(pair.agentId).slug}`);
	console.log(`Session record: ${session.sessionRecordId}`);
	console.log(`Session key: ${session.sessionKey}`);
}

export async function handlePairReject(options: PairCodeOptions, store: JsonNekoclawStore): Promise<void> {
	const pair = store.rejectPair(requireValue(options.code, "pairing code"));
	await directSendToChannel(store, pair, "Pairing was rejected by an admin.");
	console.log(chalk.green("Pairing rejected"));
}
