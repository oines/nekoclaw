import { createNapcatChannelPlugin } from "../channels/napcat.js";
import { createTelegramChannelPlugin } from "../channels/telegram.js";
import type { ChannelPlugin } from "../types.js";
import { JsonNekoclawStore } from "../store/json-store.js";
import type { ChannelSpec, ChannelType, InboundMessageEvent } from "../types.js";

interface ChannelRuntimeEntry {
	plugin: ChannelPlugin;
	fingerprint: string;
}

export class ChannelRuntimeService {
	constructor(
		private readonly store: JsonNekoclawStore,
		private readonly channelPlugins: Map<string, ChannelPlugin>,
		private readonly getRuntimeKey: (agentId: string, channelType: ChannelType) => string,
		private readonly onEvent: (agentId: string, channelType: ChannelType, event: InboundMessageEvent) => Promise<void>,
	) {}

	private readonly runtimeEntries = new Map<string, ChannelRuntimeEntry>();

	async syncAgents(): Promise<void> {
		const agents = this.store.listAgents();
		const desiredKeys = new Set<string>();
		for (const agent of agents) {
			for (const channel of this.store.listChannels(agent.agentId)) {
				const plugin = this.createChannelPlugin(agent.agentId, channel);
				if (!plugin || !agent.enabled) {
					continue;
				}
				const key = this.getRuntimeKey(agent.agentId, channel.type);
				desiredKeys.add(key);
				const fingerprint = this.getFingerprint(agent.agentId, channel);
				const existing = this.runtimeEntries.get(key);
				if (existing && existing.fingerprint === fingerprint) {
					continue;
				}
				if (existing) {
					existing.plugin.stop();
					this.runtimeEntries.delete(key);
					this.channelPlugins.delete(key);
				}
				try {
					this.channelPlugins.set(key, plugin);
					this.runtimeEntries.set(key, { plugin, fingerprint });
					plugin.startPolling({
						onEvent: async (event) => {
							await this.onEvent(agent.agentId, channel.type, event);
						},
						onError: (error) => {
							this.store.updateAgent(agent.agentId, { lastError: error.message });
							this.store.audit(agent.agentId, `${channel.type}.poll_error`, {
								channel: channel.type,
								error: error.message,
							});
						},
					});
					this.store.updateAgent(agent.agentId, { lastError: null });
				} catch (error) {
					plugin.stop();
					this.runtimeEntries.delete(key);
					this.channelPlugins.delete(key);
					const message = error instanceof Error ? error.message : String(error);
					this.store.updateAgent(agent.agentId, { lastError: message });
					this.store.audit(agent.agentId, `${channel.type}.start_error`, {
						channel: channel.type,
						error: message,
					});
				}
			}
		}
		for (const [key, plugin] of this.channelPlugins.entries()) {
			if (!desiredKeys.has(key)) {
				plugin.stop();
				this.runtimeEntries.delete(key);
				this.channelPlugins.delete(key);
			}
		}
	}

	stopAll(): void {
		for (const plugin of this.channelPlugins.values()) {
			plugin.stop();
		}
		this.runtimeEntries.clear();
		this.channelPlugins.clear();
	}

	private createChannelPlugin(agentId: string, channel: ChannelSpec): ChannelPlugin | undefined {
		if (channel.type === "telegram") {
			const token = this.store.getChannelToken(agentId, channel.type);
			if (!token) {
				return undefined;
			}
			const config = this.store.getTelegramChannelConfig(agentId);
			return createTelegramChannelPlugin(
				channel,
				token,
				{
					dm: config?.replyMode?.dm,
					group: config?.replyMode?.group,
				},
				config?.groupTrigger,
			);
		}
		const config = this.store.getNapcatChannelConfig(agentId);
		if (!config?.wsUrl || !config.selfId) {
			return undefined;
		}
		return createNapcatChannelPlugin(
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
	}

	private getFingerprint(agentId: string, channel: ChannelSpec): string {
		if (channel.type === "telegram") {
			const token = this.store.getChannelToken(agentId, channel.type);
			const config = this.store.getTelegramChannelConfig(agentId);
			return JSON.stringify({
				type: channel.type,
				token,
				replyModes: {
					dm: config?.replyMode?.dm,
					group: config?.replyMode?.group,
				},
				groupTrigger: config?.groupTrigger ?? "all",
			});
		}
		const config = this.store.getNapcatChannelConfig(agentId);
		return JSON.stringify({
			type: channel.type,
			wsUrl: config?.wsUrl,
			accessToken: config?.accessToken,
			selfId: config?.selfId,
			replyModes: {
				dm: config?.replyMode?.dm,
				group: config?.replyMode?.group,
			},
			groupTrigger: config?.groupTrigger ?? "all",
		});
	}
}
