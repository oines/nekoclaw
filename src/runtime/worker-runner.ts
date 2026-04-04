import { NEKOCLAW_CUSTOM_MODEL_API_KEY_ENV } from "../config.js";
import { hasOutboundContent, summarizeBlocks } from "../messages.js";
import { MODEL_ENV_MAP } from "../model/provider-key.js";
import { JsonNekoclawStore } from "../store/json-store.js";
import type { AgentSpec, ChannelPlugin, ReplyPayload, RunJob, SessionRecord, WorkerPayload, WorkerResult } from "../types.js";
import { runWorkerInContainer } from "./docker.js";
import { OutboundDispatchService } from "./outbound-dispatch.js";
import { PersonaMemoryService } from "./persona-memory.js";
import { parseTargetRef } from "./runtime-directory.js";
import { RuntimeDirectoryService } from "./runtime-directory.js";
import { getRuntimeKey } from "./runtime-key.js";

function summarizeReplyPayload(payload: ReplyPayload): string[] {
	const lines: string[] = [];
	if (payload.text?.trim()) {
		lines.push(`- Text: ${payload.text.trim()}`);
	}
	for (const att of payload.attachments ?? []) {
		lines.push(`- ${att.kind === "image" ? "Image" : "File"}: ${att.name ?? att.mimeType ?? "attachment"}`);
	}
	return lines;
}

function formatTranscriptTurn(speaker: string, lines: string[]): string | undefined {
	if (lines.length === 0) {
		return undefined;
	}
	return `${speaker}:\n${lines.join("\n")}`;
}

function isCurrentSessionTarget(target: string, session: Pick<SessionRecord, "channelType" | "chatKind" | "externalConversationId">): boolean {
	const parsed = parseTargetRef(target);
	if (!parsed) {
		return false;
	}
	return (
		parsed.channelType === session.channelType &&
		parsed.chatKind === session.chatKind &&
		parsed.externalConversationId === session.externalConversationId
	);
}

export function buildFormationTurnTranscript(
	job: Pick<RunJob, "event">,
	session: Pick<SessionRecord, "channelType" | "chatKind" | "externalConversationId">,
	result: WorkerResult,
): string {
	const transcriptTurns: string[] = [];
	const userTurn = formatTranscriptTurn("User", summarizeBlocks(job.event.blocks));
	if (userTurn) {
		transcriptTurns.push(userTurn);
	}

	for (const action of result.toolActions ?? []) {
		if (action.kind !== "send" && action.kind !== "reply" && action.kind !== "send_targeted") {
			continue;
		}
		if (action.kind === "send_targeted" && !isCurrentSessionTarget(action.target, session)) {
			continue;
		}
		const botTurn = formatTranscriptTurn("Bot", summarizeReplyPayload(action.payload));
		if (botTurn) {
			transcriptTurns.push(botTurn);
		}
	}

	const outboundTurn = hasOutboundContent(result.outbound)
		? formatTranscriptTurn("Bot", summarizeReplyPayload(result.outbound))
		: undefined;
	if (outboundTurn && !transcriptTurns.includes(outboundTurn)) {
		transcriptTurns.push(outboundTurn);
	}

	return transcriptTurns.join("\n\n");
}

function parseWorkerResult(stdout: string): WorkerResult {
	const lines = stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	const line = lines[lines.length - 1];
	if (!line) {
		return { outbound: {} };
	}
	try {
		return JSON.parse(line) as WorkerResult;
	} catch {
		const preview = lines.slice(-5).join("\n");
		throw new Error(`Failed to parse worker result. Last 5 lines of stdout:\n${preview}`);
	}
}

export class WorkerRunnerService {
	private readonly personaMemory: PersonaMemoryService;
	private readonly runtimeDirectory: RuntimeDirectoryService;

	constructor(
		private readonly store: JsonNekoclawStore,
		private readonly outbound: OutboundDispatchService,
		private readonly channelPlugins: Map<string, ChannelPlugin>,
		private readonly ensureContainer: (agentRef: string) => Promise<string>,
	) {
		this.personaMemory = new PersonaMemoryService(store);
		this.runtimeDirectory = new RuntimeDirectoryService(store);
	}

	async runJob(job: RunJob): Promise<WorkerResult> {
		const agent = this.store.getAgentByRef(job.agentId);
		const session = this.store.getSession(agent.agentId, job.sessionRecordId);
		const effectiveModel = this.resolveEffectiveModel(agent, session, job);
		await this.ensureContainer(agent.agentId);
		const plugin = this.channelPlugins.get(getRuntimeKey(agent.agentId, session.channelType));
		const personaContext = await this.personaMemory.buildPreparedContext(agent, session, job.event, effectiveModel);
		const runtimeDirectory = this.runtimeDirectory.buildSnapshot(agent, session, job.event);
		const payload: WorkerPayload = {
			agent,
			job,
			currentSession: session,
			capabilities: plugin?.capabilities ?? { text: true, media: false, reply: false, edit: false, delete: false, typing: false },
			runtimeDirectory,
			personaContext,
			scheduledReminder: job.scheduledReminder,
			serverTimezone: this.store.getDefaultCronTimezone(),
			sessionCrons: this.store.listActiveSessionCrons(agent.agentId, session.sessionRecordId),
			selfIdentity: this.getSelfIdentity(plugin, job),
			effectiveModel,
		};

		let typingInterval: NodeJS.Timeout | undefined;
		if (plugin?.capabilities?.typing && plugin.actions) {
			const sendTyping = () => {
				plugin.actions.typing({ chatId: session.externalConversationId }).catch(() => {});
			};
			sendTyping();
			typingInterval = setInterval(sendTyping, 4000);
		}

		try {
			const stdout = await runWorkerInContainer(agent.containerName, `${JSON.stringify(payload)}\n`, this.getWorkerEnv(agent));
			const result = parseWorkerResult(stdout);
			if (result.toolActions?.length) {
				await this.outbound.executeToolActions(agent, session, result.toolActions);
			}
			if (hasOutboundContent(result.outbound)) {
				await this.outbound.sendToSession(agent, session, job.event, result.outbound);
			}
			const turnTranscript = buildFormationTurnTranscript(job, session, result);
			this.personaMemory.scheduleFormation({
				agent,
				session,
				event: job.event,
				turnTranscript,
				personaContext,
				effectiveModel,
			});
			return result;
		} finally {
			if (typingInterval) {
				clearInterval(typingInterval);
			}
		}
	}

	private getWorkerEnv(agent: AgentSpec): Record<string, string | undefined> {
		const env: Record<string, string | undefined> = {};
		if (!agent.provider) {
			return env;
		}
		if (this.store.getModelConfig(agent.agentId)?.kind === "custom") {
			env[NEKOCLAW_CUSTOM_MODEL_API_KEY_ENV] = this.store.getCustomModelApiKey(agent.agentId);
			return env;
		}
		const envName = MODEL_ENV_MAP[agent.provider];
		const providerKey = this.store.getProviderKey(agent.agentId, agent.provider);
		if (envName && providerKey) {
			env[envName] = providerKey;
		}
		return env;
	}

	private resolveEffectiveModel(agent: AgentSpec, session: ReturnType<JsonNekoclawStore["getSession"]>, job: RunJob): WorkerPayload["effectiveModel"] {
		void job;
		return session.modelOverride
			? {
					provider: session.modelOverride.provider,
					modelId: session.modelOverride.modelId,
					thinkingLevel: agent.thinkingLevel,
				}
			: agent.provider && agent.modelId
				? {
						provider: agent.provider,
						modelId: agent.modelId,
						thinkingLevel: agent.thinkingLevel,
					}
				: undefined;
	}

	private getSelfIdentity(plugin: ChannelPlugin | undefined, job: RunJob): WorkerPayload["selfIdentity"] {
		const botIdentity = plugin?.botIdentity;
		const botUsername = botIdentity?.username?.toLowerCase();
		const botUserId = botIdentity?.userId;
		const isBotMentionedByUsername = botUsername
			? job.event.mentionedUsernames?.some((u) => u.toLowerCase() === botUsername) ?? false
			: false;
		const isBotMentionedById = botUserId
			? job.event.mentionedUserIds?.includes(botUserId) ?? false
			: false;
		const identity: NonNullable<WorkerPayload["selfIdentity"]> = {
			isExplicitlyAddressed:
				Boolean(job.event.isReplyToBot) || isBotMentionedByUsername || isBotMentionedById,
		};
		if (botUsername) {
			identity.telegramHandles = [`@${botUsername}`];
		}
		if (botUserId) {
			identity.platformUserId = botUserId;
		}
		return identity;
	}
}
