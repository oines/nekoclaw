import { existsSync, readFileSync, statSync } from "node:fs";
import { SESSION_COMPACTION_SETTINGS, SESSION_PRUNING_ENABLED } from "./session-hygiene.js";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { parseAddressedSlashCommand } from "../command-parsing.js";
import { NEKOCLAW_CUSTOM_MODEL_API_KEY_ENV } from "../config.js";
import { upsertRuntimeModelsConfig } from "../model/probe.js";
import { JsonNekoclawStore } from "../store/json-store.js";
import type {
	AgentSpec,
	ChannelPlugin,
	InboundMessageEvent,
	ModelConfig,
	PairRequest,
	ReplyPayload,
	SessionRecord,
} from "../types.js";

import type { RuntimeModelsConfig } from "../model/model-types.js";

type ParsedCommand =
	| { kind: "pair" }
	| { kind: "help" }
	| { kind: "status" }
	| { kind: "reset" }
	| { kind: "model"; scope: "session" | "global"; provider: string; modelId: string }
	| { kind: "trigger"; mode: "all" | "mention" | "" };

type MutableGroupTriggerPlugin = ChannelPlugin & { groupTrigger?: "all" | "mention" };

export class CommandRouterService {
	constructor(
		private readonly store: JsonNekoclawStore,
		private readonly getQueueStatus: (agentId: string) => { queued: number; processing: boolean; currentJobId?: string },
	) {}

	async handleCommand(
		agent: AgentSpec,
		plugin: ChannelPlugin,
		event: InboundMessageEvent,
		session: SessionRecord | undefined,
	): Promise<boolean> {
		const parsed = this.parseCommand(event);
		if (!parsed) {
			return false;
		}
		const isAdmin = this.store.isAdmin(agent.agentId, event.channelType, event.sender.externalId);
		switch (parsed.kind) {
			case "help":
				await this.reply(plugin, event, {
					text: this.buildHelpText(isAdmin),
				});
				return true;
			case "pair": {
				if (session) {
					await this.reply(plugin, event, {
						text: `This chat is already paired.\nSession key: ${session.sessionKey}`,
					});
					return true;
				}
				const sessionAddress = plugin.resolveSessionAddress(event);
				const pair = this.store.createOrReusePair(agent.agentId, {
					channelType: sessionAddress.channelType,
					externalConversationId: sessionAddress.externalConversationId,
					chatKind: sessionAddress.chatKind,
					threadId: sessionAddress.threadId,
					parentSessionKey: sessionAddress.parentSessionKey,
					senderId: event.sender.externalId,
					senderName: event.sender.displayName,
					chatTitle: event.chatTitle,
				});
				if (!this.shouldRepromptPair(pair)) {
					return true;
				}
				await this.reply(plugin, event, plugin.pairing.buildPairPrompt(pair));
				this.store.touchPairPrompt(pair.pairingId);
				this.store.audit(agent.agentId, "pair.prompted", {
					code: pair.code,
					channel: pair.channelType,
					chatKind: pair.chatKind,
				});
				return true;
			}
			case "status":
				if (!session && !isAdmin) {
					await this.reply(plugin, event, {
						text: "This conversation is not paired yet. Pair it first or ask an admin to run the command.",
					});
					return true;
				}
				await this.reply(plugin, event, {
					text: this.buildStatusText(agent, event, session, isAdmin),
				});
				return true;
			case "trigger":
				if (!isAdmin) {
					await this.reply(plugin, event, { text: "Only admins can use /trigger." });
					return true;
				}
				if (!parsed.mode) {
					await this.reply(plugin, event, {
						text: "Usage: /trigger all\nUsage: /trigger mention",
					});
					return true;
				}
				this.store.setChannelGroupTrigger(agent.agentId, event.channelType, parsed.mode);
				(plugin as MutableGroupTriggerPlugin).groupTrigger = parsed.mode;
				await this.reply(plugin, event, {
					text: `Group trigger for ${event.channelType} updated to ${parsed.mode}.`,
				});
				return true;
			case "reset":
				if (!isAdmin) {
					await this.reply(plugin, event, { text: "Only admins can use /reset." });
					return true;
				}
				if (!session) {
					await this.reply(plugin, event, { text: "This conversation is not paired, so there is no session to reset." });
					return true;
				}
				this.store.resetSession(agent.agentId, session.sessionRecordId);
				await this.reply(plugin, event, {
					text: `Session reset.\nSession key: ${session.sessionKey}\nModel override: cleared`,
				});
				return true;
			case "model":
				if (!isAdmin) {
					await this.reply(plugin, event, { text: "Only admins can use /model." });
					return true;
				}
				if (!parsed.provider || !parsed.modelId) {
					await this.reply(plugin, event, {
						text: "Usage: /model provider/model\nUsage: /model --global provider/model",
					});
					return true;
				}
				if (!this.isModelAllowed(agent, parsed.provider, parsed.modelId)) {
					const currentProvider = agent.provider ?? "(none)";
					await this.reply(plugin, event, {
						text: `Model changes must stay on the current provider.\nCurrent provider: ${currentProvider}\nRequested: ${parsed.provider}/${parsed.modelId}\nUse the CLI model set command to switch providers.`,
					});
					return true;
				}
				if (!this.isKnownModel(agent, parsed.provider, parsed.modelId)) {
					await this.reply(plugin, event, {
						text: `Unknown model ${parsed.provider}/${parsed.modelId} for ${agent.slug}.`,
					});
					return true;
				}
				if (parsed.scope === "global") {
					this.applyGlobalModel(agent, parsed.provider, parsed.modelId);
					await this.reply(plugin, event, {
						text: `Agent default model updated to ${parsed.provider}/${parsed.modelId}.`,
					});
					return true;
				}
				if (!session) {
					await this.reply(plugin, event, { text: "This conversation is not paired, so there is no session model to update." });
					return true;
				}
				const modelConfig = this.store.getModelConfig(agent.agentId);
				if (modelConfig?.kind === "custom") {
					this.ensureCustomRuntimeModel(agent, modelConfig, parsed.modelId);
				}
				this.store.setSessionModelOverride(agent.agentId, session.sessionRecordId, {
					provider: parsed.provider,
					modelId: parsed.modelId,
				});
				await this.reply(plugin, event, {
					text: `Session model updated to ${parsed.provider}/${parsed.modelId}.\nSession key: ${session.sessionKey}`,
				});
				return true;
		}
	}

	private parseCommand(event: InboundMessageEvent): ParsedCommand | undefined {
		const parsed = parseAddressedSlashCommand(event);
		if (!parsed) {
			return undefined;
		}
		const { command, args } = parsed;
		switch (command) {
			case "pair":
				return { kind: "pair" };
			case "help":
				return { kind: "help" };
			case "status":
				return { kind: "status" };
			case "trigger": {
				const mode = args[0];
				if (mode === "all" || mode === "mention") {
					return { kind: "trigger", mode };
				}
				return { kind: "trigger", mode: "" };
			}
			case "reset":
				return { kind: "reset" };
			case "model": {
				const normalizedArgs = [...args];
				const scope = normalizedArgs[0] === "--global" ? "global" : "session";
				if (scope === "global") {
					normalizedArgs.shift();
				}
				const modelRef = normalizedArgs[0];
				if (!modelRef) {
					return { kind: "model", scope, provider: "", modelId: "" };
				}
				const slashIndex = modelRef.indexOf("/");
				if (slashIndex <= 0 || slashIndex === modelRef.length - 1) {
					return { kind: "model", scope, provider: "", modelId: "" };
				}
				return {
					kind: "model",
					scope,
					provider: modelRef.slice(0, slashIndex),
					modelId: modelRef.slice(slashIndex + 1),
				};
			}
			default:
				return undefined;
		}
	}

	private buildStatusText(
		agent: AgentSpec,
		event: InboundMessageEvent,
		session: SessionRecord | undefined,
		isAdmin: boolean,
	): string {
		const queue = this.getQueueStatus(agent.agentId);
		const effectiveModel = session?.modelOverride
			? `${session.modelOverride.provider}/${session.modelOverride.modelId} (session override)`
			: agent.provider && agent.modelId
				? `${agent.provider}/${agent.modelId}`
				: "none";
		const hygiene = this.getSessionHygiene(agent, session);
		return [
			`Agent: ${agent.slug}`,
			`Role: ${isAdmin ? "admin" : "user"}`,
			`Platform user id: ${event.sender.externalId || "unavailable"}`,
			`Effective model: ${effectiveModel}`,
			`Channel trigger: ${this.getChannelGroupTrigger(agent, event.channelType)}`,
			`Session key: ${session?.sessionKey ?? "none"}`,
			`Queue: queued=${queue.queued}, processing=${queue.processing ? "yes" : "no"}, current=${queue.currentJobId ?? "none"}`,
			`Compaction: enabled=${SESSION_COMPACTION_SETTINGS.enabled ? "yes" : "no"}`,
			`Compaction reserveTokens: ${SESSION_COMPACTION_SETTINGS.reserveTokens}`,
			`Compaction keepRecentTokens: ${SESSION_COMPACTION_SETTINGS.keepRecentTokens}`,
			`Context file size: ${hygiene.contextFileSize}`,
			`Compactions: ${hygiene.compactions}`,
			`Pruning: ${SESSION_PRUNING_ENABLED ? "enabled" : "disabled"}`,
		].join("\n");
	}

	private getSessionHygiene(
		agent: AgentSpec,
		session: SessionRecord | undefined,
	): { contextFileSize: string; compactions: string } {
		if (!session) {
			return {
				contextFileSize: "none",
				compactions: "unknown",
			};
		}
		const contextPath = this.store.getSessionContextPath(agent.slug, session.sessionRecordId);
		if (!existsSync(contextPath)) {
			return {
				contextFileSize: "0 bytes",
				compactions: "0",
			};
		}
		const sizeBytes = statSync(contextPath).size;
		try {
			const lines = readFileSync(contextPath, "utf-8")
				.split(/\r?\n/)
				.filter((line) => line.trim().length > 0);
			const compactions = lines.reduce((total, line) => {
				try {
					const parsed = JSON.parse(line) as { type?: string };
					return total + (parsed.type === "compaction" ? 1 : 0);
				} catch {
					return total;
				}
			}, 0);
			return {
				contextFileSize: `${sizeBytes} bytes`,
				compactions: String(compactions),
			};
		} catch {
			return {
				contextFileSize: `${sizeBytes} bytes`,
				compactions: "unknown",
			};
		}
	}

	private buildHelpText(isAdmin: boolean): string {
		const lines = [
			"Available commands:",
			"/help - Show this command list",
			"/status - Show session status and your platform user id",
			"/pair - Pair the current chat if it is not paired yet",
		];
		if (isAdmin) {
			lines.push("/reset - Reset the current session");
			lines.push("/model provider/model - Change the current session model");
			lines.push("/model --global provider/model - Change the agent default model");
			lines.push("/trigger all - Trigger on every group message for this channel");
			lines.push("/trigger mention - Trigger only on mentions for this channel");
		}
		return lines.join("\n");
	}

	private getChannelGroupTrigger(agent: AgentSpec, channelType: InboundMessageEvent["channelType"]): "all" | "mention" {
		if (channelType === "telegram") {
			return this.store.getTelegramChannelConfig(agent.agentId)?.groupTrigger ?? "all";
		}
		return this.store.getNapcatChannelConfig(agent.agentId)?.groupTrigger ?? "all";
	}

	private isModelAllowed(agent: AgentSpec, provider: string, modelId: string): boolean {
		if (!provider || !modelId) {
			return false;
		}
		return provider === agent.provider;
	}

	private isKnownModel(agent: AgentSpec, provider: string, modelId: string): boolean {
		const modelConfig = this.store.getModelConfig(agent.agentId);
		if (!modelConfig || provider !== agent.provider) {
			return false;
		}
		if (modelConfig.kind === "builtin") {
			const registry = new ModelRegistry(AuthStorage.inMemory(), this.store.getRuntimeModelsPath(agent.slug));
			return Boolean(registry.find(provider, modelId));
		}
		return this.isKnownCustomModel(agent, modelConfig, modelId);
	}

	private isKnownCustomModel(agent: AgentSpec, modelConfig: Extract<ModelConfig, { kind: "custom" }>, modelId: string): boolean {
		const config = this.store.readRuntimeModelsConfig(agent.agentId) as RuntimeModelsConfig | undefined;
		const provider = config?.providers?.[modelConfig.providerId];
		const ids = (provider?.models ?? []).map((entry) => entry.id).filter(Boolean);
		if (ids.length === 0) {
			return true;
		}
		return ids.includes(modelId);
	}

	private applyGlobalModel(agent: AgentSpec, provider: string, modelId: string): void {
		const modelConfig = this.store.getModelConfig(agent.agentId);
		if (!modelConfig) {
			throw new Error(`No model configured for ${agent.slug}`);
		}
		if (modelConfig.kind === "builtin") {
			this.store.setBuiltinModelConfig(agent.agentId, {
				provider,
				modelId,
				apiKey: modelConfig.apiKey,
				thinkingLevel: modelConfig.thinkingLevel,
			});
			return;
		}
		this.ensureCustomRuntimeModel(agent, modelConfig, modelId);
		this.store.setCustomModelConfig(agent.agentId, {
			baseUrl: modelConfig.baseUrl,
			api: modelConfig.api,
			providerId: modelConfig.providerId,
			modelId,
			apiKey: modelConfig.apiKey,
			thinkingLevel: modelConfig.thinkingLevel,
		});
	}

	private ensureCustomRuntimeModel(
		agent: AgentSpec,
		modelConfig: Extract<ModelConfig, { kind: "custom" }>,
		modelId: string,
	): void {
		const current = this.store.readRuntimeModelsConfig(agent.agentId) as RuntimeModelsConfig | undefined;
		const config = upsertRuntimeModelsConfig(current, {
			baseUrl: modelConfig.baseUrl,
			api: modelConfig.api,
			provider: modelConfig.providerId,
			apiKeyEnv: NEKOCLAW_CUSTOM_MODEL_API_KEY_ENV,
			modelId,
		});
		this.store.writeRuntimeModelsConfig(agent.agentId, config, {
			source: "runtime-command",
			providerId: modelConfig.providerId,
			modelId,
		});
	}

	private async reply(plugin: ChannelPlugin, event: InboundMessageEvent, payload: ReplyPayload): Promise<void> {
		await plugin.actions.reply({
			chatId: event.chatId,
			chatKind: event.chatKind,
			replyToId: event.messageId,
			payload,
		});
	}

	private shouldRepromptPair(pair: PairRequest): boolean {
		return !(
			pair.lastPromptedAt &&
			Date.now() - new Date(pair.lastPromptedAt).getTime() <
				this.store.getPairingConfig().repromptCooldownSeconds * 1000
		);
	}
}
