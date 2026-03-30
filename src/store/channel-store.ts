import type {
	ChannelSpec,
	ChannelType,
	GroupTriggerMode,
	NapcatChannelConfig,
	TelegramChannelConfig,
} from "../types.js";
import { ConfigRepository } from "./config-repository.js";
import { normalizeChannelSpec, nowIso } from "./helpers.js";

export class ChannelStore {
	constructor(private readonly repo: ConfigRepository) {}

	listChannels(agentId?: string): ChannelSpec[] {
		const channels: ChannelSpec[] = [];
		const config = this.repo.readConfig();
		for (const agent of Object.values(config.agents)) {
			if (agentId && agent.agentId !== agentId) {
				continue;
			}
			for (const type of ["telegram", "napcat"] as const) {
				const entry = agent.channels[type];
				if (entry) {
					channels.push(normalizeChannelSpec(agent.agentId, type, entry.addedAt, entry.updatedAt));
				}
			}
		}
		return channels.sort((a, b) => a.type.localeCompare(b.type));
	}

	getChannel(agentRef: string, type: ChannelType): ChannelSpec {
		const { slug, config } = this.repo.getAgentEntry(agentRef);
		const found = this.listChannels(config.agentId).find((channel) => channel.type === type);
		if (!found) {
			throw new Error(`Agent "${slug}" does not have a ${type} channel`);
		}
		return found;
	}

	createChannel(agentRef: string, type: ChannelType): ChannelSpec {
		const timestamp = nowIso();
		return this.repo.updateConfig((config) => {
			for (const [slug, agent] of Object.entries(config.agents)) {
				if (slug !== agentRef && agent.agentId !== agentRef) {
					continue;
				}
				if (agent.channels[type]) {
					throw new Error(`Agent "${slug}" already has a ${type} channel`);
				}
				if (type === "telegram") {
					agent.channels.telegram = {
						groupTrigger: "all",
						addedAt: timestamp,
						updatedAt: timestamp,
					};
				} else {
					agent.channels.napcat = {
						groupTrigger: "all",
						addedAt: timestamp,
						updatedAt: timestamp,
					};
				}
				agent.updatedAt = timestamp;
				return normalizeChannelSpec(agent.agentId, type, timestamp, timestamp);
			}
			throw new Error(`Unknown agent "${agentRef}"`);
		});
	}

	removeChannel(agentRef: string, type: ChannelType): ChannelSpec {
		const { slug, config } = this.repo.getAgentEntry(agentRef);
		const current = this.getChannel(config.agentId, type);
		this.repo.updateConfig((storeConfig) => {
			if (type === "telegram") {
				delete storeConfig.agents[slug].channels.telegram;
			} else {
				delete storeConfig.agents[slug].channels.napcat;
			}
			storeConfig.agents[slug].updatedAt = nowIso();
		});
		return current;
	}

	setChannelToken(agentRef: string, type: ChannelType, token: string): void {
		const { slug } = this.repo.getAgentEntry(agentRef);
		this.repo.updateConfig((config) => {
			const entry = config.agents[slug];
			if (type === "telegram") {
				if (!entry.channels.telegram) {
					throw new Error(`Agent "${slug}" does not have a telegram channel`);
				}
				entry.channels.telegram.token = token;
				entry.channels.telegram.updatedAt = nowIso();
				entry.updatedAt = entry.channels.telegram.updatedAt;
				return;
			}
			if (!entry.channels.napcat) {
				throw new Error(`Agent "${slug}" does not have a napcat channel`);
			}
			entry.channels.napcat.accessToken = token;
			entry.channels.napcat.updatedAt = nowIso();
			entry.updatedAt = entry.channels.napcat.updatedAt;
		});
	}

	getChannelToken(agentId: string, type: ChannelType): string | undefined {
		const { config } = this.repo.getAgentEntryById(agentId);
		if (type === "telegram") {
			return config.channels.telegram?.token;
		}
		return config.channels.napcat?.accessToken;
	}

	getTelegramChannelConfig(agentId: string): TelegramChannelConfig | undefined {
		return this.repo.getAgentEntryById(agentId).config.channels.telegram;
	}

	getNapcatChannelConfig(agentId: string): NapcatChannelConfig | undefined {
		return this.repo.getAgentEntryById(agentId).config.channels.napcat;
	}

	setNapcatEndpoint(agentRef: string, input: { wsUrl: string; selfId?: string }): void {
		const { slug } = this.repo.getAgentEntry(agentRef);
		const wsUrl = input.wsUrl.trim();
		if (!wsUrl) {
			throw new Error("NapCat WebSocket URL is required");
		}
		this.repo.updateConfig((config) => {
			const entry = config.agents[slug];
			if (!entry.channels.napcat) {
				throw new Error(`Agent "${slug}" does not have a napcat channel`);
			}
			entry.channels.napcat.wsUrl = wsUrl;
			entry.channels.napcat.selfId = input.selfId?.trim() || undefined;
			entry.channels.napcat.updatedAt = nowIso();
			entry.updatedAt = entry.channels.napcat.updatedAt;
		});
	}

	setGroupTrigger(agentRef: string, type: ChannelType, groupTrigger: GroupTriggerMode): void {
		const { slug } = this.repo.getAgentEntry(agentRef);
		this.repo.updateConfig((config) => {
			const entry = config.agents[slug];
			const timestamp = nowIso();
			if (type === "telegram") {
				if (!entry.channels.telegram) {
					throw new Error(`Agent "${slug}" does not have a telegram channel`);
				}
				entry.channels.telegram.groupTrigger = groupTrigger;
				entry.channels.telegram.updatedAt = timestamp;
				entry.updatedAt = timestamp;
				return;
			}
			if (!entry.channels.napcat) {
				throw new Error(`Agent "${slug}" does not have a napcat channel`);
			}
			entry.channels.napcat.groupTrigger = groupTrigger;
			entry.channels.napcat.updatedAt = timestamp;
			entry.updatedAt = timestamp;
		});
	}
}
