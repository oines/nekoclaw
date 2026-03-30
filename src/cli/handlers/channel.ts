import chalk from "chalk";
import { createNapcatChannelPlugin } from "../../channels/napcat.js";
import { createTelegramChannelPlugin } from "../../channels/telegram.js";
import { NEKOCLAW_NAME } from "../../config.js";
import { JsonNekoclawStore } from "../../store/json-store.js";
import type { ChannelType, PairRequest } from "../../types.js";
import { ask, requireValue, type ChannelEndpointOptions, type ChannelTokenOptions, type ChannelTriggerOptions, type ForceOptions } from "./shared.js";

export async function directSendToChannel(store: JsonNekoclawStore, pair: PairRequest, text: string): Promise<void> {
	const channel = store.getChannel(pair.agentId, pair.channelType);
	if (channel.type === "telegram") {
		const token = store.getChannelToken(pair.agentId, channel.type);
		if (!token) {
			return;
		}
		const plugin = createTelegramChannelPlugin(
			channel,
			token,
			{
				dm: store.getTelegramChannelConfig(pair.agentId)?.replyMode?.dm,
				group: store.getTelegramChannelConfig(pair.agentId)?.replyMode?.group,
			},
			store.getTelegramChannelConfig(pair.agentId)?.groupTrigger,
		);
		await plugin.actions.send({
			chatId: pair.externalConversationId,
			chatKind: pair.chatKind,
			payload: { text },
		});
		return;
	}
	const config = store.getNapcatChannelConfig(pair.agentId);
	if (!config?.wsUrl || !config.selfId) {
		return;
	}
	const plugin = createNapcatChannelPlugin(
		channel,
		{
			wsUrl: config.wsUrl,
			accessToken: config.accessToken,
			selfId: config.selfId,
		},
		{
			dm: config.replyMode?.dm,
			group: config.replyMode?.group,
		},
		config.groupTrigger,
	);
	await plugin.actions.send({
		chatId: pair.externalConversationId,
		chatKind: pair.chatKind,
		payload: { text },
	});
	plugin.stop();
}

export async function handleChannelAdd(agentRef: string, type: ChannelType | undefined, store: JsonNekoclawStore): Promise<void> {
	const resolvedType = type ?? "telegram";
	store.createChannel(agentRef, resolvedType);
	console.log(chalk.green(`Added ${resolvedType} channel to ${store.getAgentByRef(agentRef).slug}`));
}

export async function handleChannelRemove(agentRef: string, type: ChannelType | undefined, options: ForceOptions, store: JsonNekoclawStore): Promise<void> {
	const resolvedType = type ?? "telegram";
	store.removeChannel(agentRef, resolvedType, { force: Boolean(options.force) });
	console.log(chalk.green(`Removed ${resolvedType} channel from ${store.getAgentByRef(agentRef).slug}`));
}

export async function handleChannelList(agentRef: string, store: JsonNekoclawStore): Promise<void> {
	const agent = store.getAgentByRef(agentRef);
	const channels = store.listChannels(agent.agentId);
	if (channels.length === 0) {
		console.log(`No channels configured. Run: ${NEKOCLAW_NAME} channel add ${agent.slug} telegram`);
		return;
	}
	for (const channel of channels) {
		const tokenSaved = store.getChannelToken(channel.agentId, channel.type) ? "yes" : "no";
		if (channel.type === "napcat") {
			const config = store.getNapcatChannelConfig(channel.agentId);
			console.log(
				`${channel.type}\tconfigured=${tokenSaved}\tendpoint=${config?.wsUrl ? "yes" : "no"}\tself-id=${config?.selfId ?? "-"}\tgroup-trigger=${config?.groupTrigger ?? "all"}`,
			);
			continue;
		}
		const config = store.getTelegramChannelConfig(channel.agentId);
		console.log(`${channel.type}\tconfigured=${tokenSaved}\tgroup-trigger=${config?.groupTrigger ?? "all"}`);
	}
}

export async function handleChannelToken(agentRef: string, type: ChannelType | undefined, options: ChannelTokenOptions, store: JsonNekoclawStore): Promise<void> {
	const resolvedType = type ?? "telegram";
	const token = options.token || (await ask(resolvedType === "telegram" ? "Telegram bot token" : "NapCat access token"));
	store.getChannel(agentRef, resolvedType);
	store.setChannelToken(agentRef, resolvedType, token);
	console.log(chalk.green(`Saved ${resolvedType} token for ${store.getAgentByRef(agentRef).slug}`));
}

export async function handleChannelEndpoint(
	agentRef: string,
	type: ChannelType | undefined,
	options: ChannelEndpointOptions,
	store: JsonNekoclawStore,
): Promise<void> {
	const resolvedType = type ?? "napcat";
	if (resolvedType !== "napcat") {
		throw new Error("Only napcat channels support endpoint configuration");
	}
	const wsUrl = options.url || (await ask("NapCat WebSocket URL"));
	const selfId = options.selfId || (await ask("NapCat self QQ id"));
	store.getChannel(agentRef, resolvedType);
	store.setNapcatEndpoint(agentRef, {
		wsUrl,
		selfId,
	});
	console.log(chalk.green(`Saved ${resolvedType} endpoint for ${store.getAgentByRef(agentRef).slug}`));
}

export async function handleChannelTrigger(
	agentRef: string,
	type: ChannelType | undefined,
	options: ChannelTriggerOptions,
	store: JsonNekoclawStore,
): Promise<void> {
	const resolvedType = type ?? "telegram";
	const groupTrigger = options.group;
	if (!groupTrigger) {
		throw new Error("Missing group trigger mode. Use --group all or --group mention.");
	}
	store.getChannel(agentRef, resolvedType);
	store.setChannelGroupTrigger(agentRef, resolvedType, groupTrigger);
	console.log(chalk.green(`Saved ${resolvedType} group trigger for ${store.getAgentByRef(agentRef).slug}`));
	console.log(`Group trigger: ${groupTrigger}`);
}
