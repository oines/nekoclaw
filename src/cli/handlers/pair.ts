import chalk from "chalk";
import { JsonNekoclawStore } from "../../store/json-store.js";
import type { PairCodeOptions, PairListOptions } from "./shared.js";
import { requireValue } from "./shared.js";
import { directSendToChannel } from "./channel.js";

import Table from "cli-table3";

export async function handlePairList(options: PairListOptions, store: JsonNekoclawStore): Promise<void> {
	const agentId = options.agent ? store.getAgentByRef(options.agent).agentId : undefined;
	const pairs = store.listPairRequests(agentId);
	if (pairs.length === 0) {
		console.log("No pending pair requests.");
		return;
	}
	const table = new Table({
		head: ["CODE", "AGENT", "CHANNEL", "TYPE", "FROM", "STATUS"].map((h) => chalk.bold(h)),
		chars: { mid: "", "left-mid": "", "mid-mid": "", "right-mid": "" },
	});
	for (const pair of pairs) {
		const agent = store.getAgentByRef(pair.agentId);
		const status =
			pair.status === "accepted"
				? chalk.green(pair.status)
				: pair.status === "rejected"
					? chalk.red(pair.status)
					: chalk.yellow(pair.status);
		table.push([pair.code, agent.slug, pair.channelType, pair.chatKind, pair.senderName ?? "-", status]);
	}
	console.log(table.toString());
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
