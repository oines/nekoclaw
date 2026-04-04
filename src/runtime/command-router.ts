import { existsSync } from "node:fs";
import { SESSION_COMPACTION_SETTINGS, SESSION_PRUNING_ENABLED } from "./session-hygiene.js";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { parseAddressedSlashCommand } from "../command-parsing.js";
import { NEKOCLAW_CUSTOM_MODEL_API_KEY_ENV } from "../config.js";
import { upsertRuntimeModelsConfig } from "../model/probe.js";
import { readJsonLines } from "../store/fs.js";
import { JsonNekoclawStore } from "../store/json-store.js";
import { TokenService } from "./token-service.js";
import type {
	AgentSpec,
	ChannelPlugin,
	InboundMessageEvent,
	QueueStatus,
	ModelConfig,
	PairRequest,
	ReplyPayload,
	SessionRecord,
} from "../types.js";

import type { RuntimeModelsConfig } from "../model/model-types.js";

interface SessionContextUsageEntry {
	type?: string;
	message?: {
		role?: string;
		usage?: {
			input?: number;
			totalTokens?: number;
		};
	};
}

type ParsedCommand =
	| { kind: "pair" }
	| { kind: "help" }
	| { kind: "status" }
	| { kind: "stop" }
	| { kind: "reset" }
	| { kind: "model"; scope: "session" | "global"; provider: string; modelId: string }
	| { kind: "trigger"; mode: "all" | "mention" | "" };

type MutableGroupTriggerPlugin = ChannelPlugin & { groupTrigger?: "all" | "mention" };

export class CommandRouterService {
	private readonly tokenService: TokenService;

	constructor(
		private readonly store: JsonNekoclawStore,
		private readonly getQueueStatus: (agentId: string) => QueueStatus,
		private readonly stopSession: (agentId: string, sessionRecordId: string) => { removedQueuedCount: number; hadQueuedWork: boolean } = () => ({
			removedQueuedCount: 0,
			hadQueuedWork: false,
		}),
	) {
		this.tokenService = new TokenService(store);
	}

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
					text: await this.buildStatusText(agent, event, session, isAdmin),
				});
				return true;
			case "stop":
				if (!session) {
					await this.reply(plugin, event, {
						text: "当前会话没有正在排队的任务。",
					});
					return true;
				}
				const stopResult = this.stopSession(agent.agentId, session.sessionRecordId);
				await this.reply(plugin, event, {
					text:
						stopResult.removedQueuedCount > 0
							? `已停止当前会话的后续任务：清除了 ${stopResult.removedQueuedCount} 个排队任务。`
							: "当前会话没有正在排队的任务。",
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
			case "stop":
				return { kind: "stop" };
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

	private async buildStatusText(
		agent: AgentSpec,
		event: InboundMessageEvent,
		session: SessionRecord | undefined,
		isAdmin: boolean,
	): Promise<string> {
		const queue = this.getQueueStatus(agent.agentId);
		const activeRunsSummary =
			queue.activeRuns && queue.activeRuns.length > 0
				? queue.activeRuns.map((run) => `${run.sessionRecordId}:${run.jobId}`).join(", ")
				: "none";
		const effectiveModel = session?.modelOverride
			? `${session.modelOverride.provider}/${session.modelOverride.modelId} (session override)`
			: agent.provider && agent.modelId
				? `${agent.provider}/${agent.modelId}`
				: "none";
		const hygiene = await this.getSessionHygiene(agent, session);
		return [
			`Agent: ${agent.slug}`,
			`Role: ${isAdmin ? "admin" : "user"}`,
			`Platform user id: ${event.sender.externalId || "unavailable"}`,
			`Effective model: ${effectiveModel}`,
			`Channel trigger: ${this.getChannelGroupTrigger(agent, event.channelType)}`,
			`Session key: ${session?.sessionKey ?? "none"}`,
			`Queue: queued=${queue.queued}, processing=${queue.processing ? "yes" : "no"}, running_sessions=${queue.runningSessions ?? (queue.processing ? 1 : 0)}, current=${queue.currentJobId ?? "none"}, limit=${queue.maxConcurrentSessions ?? 1}`,
			`Active runs: ${activeRunsSummary}`,
			`Compaction: enabled=${SESSION_COMPACTION_SETTINGS.enabled ? "yes" : "no"}`,
			`Compaction reserveTokens: ${SESSION_COMPACTION_SETTINGS.reserveTokens}`,
			`Compaction keepRecentTokens: ${SESSION_COMPACTION_SETTINGS.keepRecentTokens}`,
			`Context: ${hygiene.contextUsage}`,
			`Compactions: ${hygiene.compactions}`,
			`Pruning: ${SESSION_PRUNING_ENABLED ? "enabled" : "disabled"}`,
		].join("\n");
	}

	private async getSessionHygiene(
		agent: AgentSpec,
		session: SessionRecord | undefined,
	): Promise<{ contextUsage: string; compactions: string }> {
		if (!session) {
			return {
				contextUsage: "none",
				compactions: "unknown",
			};
		}
		const contextPath = this.store.getSessionContextPath(agent.slug, session.sessionRecordId);
		const tokenModel = await this.tokenService.resolveEffectiveModelWithContext(agent, session);
		if (!existsSync(contextPath)) {
			return {
				contextUsage: this.formatContextUsage(0, tokenModel?.contextWindow),
				compactions: "0",
			};
		}
		try {
			const lines = readJsonLines<SessionContextUsageEntry>(contextPath);
			const compactions = lines.reduce((total, line) => total + (line.type === "compaction" ? 1 : 0), 0);
			return {
				contextUsage: this.formatContextUsage(this.findLatestPromptUsage(lines) ?? 0, tokenModel?.contextWindow),
				compactions: String(compactions),
			};
		} catch {
			return {
				contextUsage: this.formatContextUsage(undefined, tokenModel?.contextWindow),
				compactions: "unknown",
			};
		}
	}

	private findLatestPromptUsage(lines: SessionContextUsageEntry[]): number | undefined {
		for (let index = lines.length - 1; index >= 0; index -= 1) {
			const usage = lines[index]?.message?.usage;
			if (typeof usage?.input === "number" && Number.isFinite(usage.input) && usage.input >= 0) {
				return usage.input;
			}
			if (typeof usage?.totalTokens === "number" && Number.isFinite(usage.totalTokens) && usage.totalTokens >= 0) {
				return usage.totalTokens;
			}
		}
		return undefined;
	}

	private formatContextUsage(usedTokens: number | undefined, contextWindow: number | undefined): string {
		const usedLabel = usedTokens === undefined ? "?" : this.formatCompactTokens(usedTokens);
		const maxLabel = contextWindow === undefined ? "?" : this.formatCompactTokens(contextWindow);
		if (usedTokens !== undefined && contextWindow !== undefined && contextWindow > 0) {
			return `${usedLabel}/${maxLabel} (${this.formatPercent(usedTokens, contextWindow)})`;
		}
		return `${usedLabel}/${maxLabel}`;
	}

	private formatCompactTokens(value: number): string {
		if (value >= 1_000_000) {
			return `${this.formatCompactNumber(value / 1_000_000)}m`;
		}
		if (value >= 1_000) {
			return `${this.formatCompactNumber(value / 1_000)}k`;
		}
		return value.toLocaleString("en-US");
	}

	private formatCompactNumber(value: number): string {
		const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
		return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
	}

	private formatPercent(used: number, max: number): string {
		if (max <= 0) {
			return "0%";
		}
		const rounded = Math.round((used / max) * 1000) / 10;
		return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
	}

	private buildHelpText(isAdmin: boolean): string {
		const lines = [
			"Available commands:",
			"/help - Show this command list",
			"/status - Show session status and your platform user id",
			"/pair - Pair the current chat if it is not paired yet",
			"/stop - Clear queued follow-up tasks for the current session",
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
