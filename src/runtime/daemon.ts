import { inspectContainerStatus, ensureAgentContainer, removeAgentContainer, stopAgentContainer } from "./docker.js";
import type { AgentSpec, PairRequest } from "../types/agent.js";
import type { ChannelPlugin } from "../types/channel.js";
import type { ChannelType } from "../types/common.js";
import type { InboundMessageEvent } from "../types/message.js";
import type { RunJob } from "../types/runtime.js";
import { JsonNekoclawStore } from "../store/json-store.js";
import { nowIso } from "../store/helpers.js";
import { ChannelRuntimeService } from "./channel-runtime.js";
import { CommandRouterService } from "./command-router.js";
import { JobQueueService } from "./job-queue.js";
import { MessageRouterService } from "./message-router.js";
import { OutboundDispatchService } from "./outbound-dispatch.js";
import { RuntimeControlService } from "./runtime-control.js";
import { RuntimeBusyError } from "./errors.js";
import { getRuntimeKey } from "./runtime-key.js";
import { WorkerRunnerService } from "./worker-runner.js";
import { PersonaMemoryService } from "./persona-memory.js";

export class NekoclawDaemon {
	private channelPlugins = new Map<string, ChannelPlugin>();
	private agentQueues = new Map<string, Map<string, RunJob[]>>();
	private activeRunsByAgent = new Map<string, Map<string, { sessionRecordId: string; jobId: string; startedAt: string }>>();
	private containerStartLocks = new Map<string, Promise<string>>();
	private syncTimer: NodeJS.Timeout | undefined;
	private keepAliveTimer: NodeJS.Timeout | undefined;
	private shuttingDown = false;
	private stopPromise: Promise<void> | undefined;

	private readonly outboundDispatch: OutboundDispatchService;
	private readonly workerRunner: WorkerRunnerService;
	private readonly jobQueue: JobQueueService;
	private readonly messageRouter: MessageRouterService;
	private readonly channelRuntime: ChannelRuntimeService;
	private readonly runtimeControl: RuntimeControlService;
	private readonly personaMemory: PersonaMemoryService;

	constructor(private store: JsonNekoclawStore = new JsonNekoclawStore()) {
		this.outboundDispatch = new OutboundDispatchService(this.store, this.channelPlugins);
		this.personaMemory = new PersonaMemoryService(this.store);
		this.workerRunner = new WorkerRunnerService(this.store, this.outboundDispatch, this.channelPlugins, (agentRef) => this.startAgentContainer(agentRef));
		this.jobQueue = new JobQueueService(this.store, this.agentQueues, this.activeRunsByAgent, (job) => this.workerRunner.runJob(job));
		const commands = new CommandRouterService(this.store, (agentId) => this.jobQueue.getStatus(agentId));
		this.messageRouter = new MessageRouterService(this.store, this.channelPlugins, commands, (job) => this.jobQueue.enqueue(job));
		this.channelRuntime = new ChannelRuntimeService(this.store, this.channelPlugins, getRuntimeKey, (agentId, channelType, event) =>
			this.messageRouter.handleInbound(agentId, channelType, event),
		);
		this.runtimeControl = new RuntimeControlService(this.store, this.channelPlugins, this.agentQueues, this.activeRunsByAgent);
	}

	async start(): Promise<void> {
		this.shuttingDown = false;
		this.stopPromise = undefined;
		this.jobQueue.initialize();
		await this.processRuntimeControlActions();
		await this.channelRuntime.syncAgents();
		await this.processDueCrons();
		this.queuePersonaBacklogSweeps();
		this.syncTimer = setInterval(() => {
			void this.processRuntimeControlActions().then(() => {
				void this.channelRuntime.syncAgents();
				void this.processDueCrons();
				this.queuePersonaBacklogSweeps();
			});
		}, 2_000);
		this.keepAliveTimer = setInterval(() => undefined, 60_000);
	}

	async stop(): Promise<void> {
		if (this.stopPromise) {
			return this.stopPromise;
		}
		this.stopPromise = this.stopInternal();
		return this.stopPromise;
	}

	private async stopInternal(): Promise<void> {
		this.shuttingDown = true;
		this.channelRuntime.stopAll();
		if (this.syncTimer) {
			clearInterval(this.syncTimer);
			this.syncTimer = undefined;
		}
		if (this.keepAliveTimer) {
			clearInterval(this.keepAliveTimer);
			this.keepAliveTimer = undefined;
		}
		const deadline = Date.now() + 30_000;
		while (this.jobQueue.hasAnyActiveRuns() && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		this.jobQueue.compactIdleQueues();
		this.store.writeRuntimeProcessState({
			updatedAt: nowIso(),
		});
	}

	async startAgentContainer(agentRef: string): Promise<string> {
		const agent = this.store.getAgentByRef(agentRef);
		const existing = this.containerStartLocks.get(agent.agentId);
		if (existing) {
			return existing;
		}
		const pending = (async () => {
			const status = await ensureAgentContainer(agent, this.store.getWorkspaceRoot(agent.slug));
			this.store.writeRuntimeState({
				...this.store.getRuntimeState(agent.agentId),
				agentId: agent.agentId,
				containerStatus: status,
				updatedAt: nowIso(),
			});
			return status;
		})();
		this.containerStartLocks.set(agent.agentId, pending);
		try {
			return await pending;
		} finally {
			if (this.containerStartLocks.get(agent.agentId) === pending) {
				this.containerStartLocks.delete(agent.agentId);
			}
		}
	}

	async stopAgentContainer(agentRef: string): Promise<void> {
		const agent = this.store.getAgentByRef(agentRef);
		await stopAgentContainer(agent.containerName);
		this.store.writeRuntimeState({
			...this.store.getRuntimeState(agent.agentId),
			containerStatus: "stopped",
			updatedAt: nowIso(),
		});
	}

	async removeAgentContainer(agentRef: string): Promise<void> {
		const agent = this.store.getAgentByRef(agentRef);
		await removeAgentContainer(agent.containerName);
		this.store.writeRuntimeState({
			...this.store.getRuntimeState(agent.agentId),
			containerStatus: "missing",
			activeRuns: [],
			updatedAt: nowIso(),
		});
	}

	async removeAgentRuntime(agentRef: string | Pick<AgentSpec, "agentId" | "containerName">): Promise<void> {
		await this.runtimeControl.removeAgentRuntime(agentRef);
	}

	async processRuntimeControlActions(): Promise<void> {
		await this.runtimeControl.processRuntimeControlActions();
	}

	async getAgentContainerStatus(agentRef: string): Promise<string> {
		const agent = this.store.getAgentByRef(agentRef);
		const status = await inspectContainerStatus(agent.containerName);
		this.store.writeRuntimeState({
			...this.store.getRuntimeState(agent.agentId),
			containerStatus: status,
			updatedAt: nowIso(),
		});
		return status;
	}

	async enqueue(job: RunJob): Promise<void> {
		if (this.shuttingDown) {
			throw new RuntimeBusyError("Daemon is shutting down");
		}
		await this.jobQueue.enqueue(job);
	}

	async sendPairAcceptedMessage(pair: PairRequest): Promise<void> {
		await this.outboundDispatch.sendPairAcceptedMessage(pair);
	}

	async sendPairRejectedMessage(pair: PairRequest): Promise<void> {
		await this.outboundDispatch.sendPairRejectedMessage(pair);
	}

	async handleInbound(agentId: string, channelType: ChannelType, event: InboundMessageEvent): Promise<void> {
		await this.messageRouter.handleInbound(agentId, channelType, event);
	}

	private queuePersonaBacklogSweeps(): void {
		for (const agent of this.store.listAgents()) {
			if (this.jobQueue.hasActiveRuns(agent.agentId)) {
				this.personaMemory.noteDreamSkip(agent, "agent_busy");
				continue;
			}
			this.personaMemory.queueBacklogSweep(agent);
			this.personaMemory.queueDream(agent);
		}
	}

	private async processDueCrons(): Promise<void> {
		for (const cron of this.store.listDueCrons()) {
			try {
				const session = this.store.getSession(cron.agentId, cron.sessionRecordId);
				if (session.status !== "active" || session.resetGeneration !== cron.createdFromResetGeneration) {
					this.store.invalidateCron(cron.cronId, session.status !== "active" ? "session_inactive" : "reset_generation_mismatch");
					continue;
				}
				const scheduledFor = cron.nextRunAt;
				await this.enqueue({
					jobId: `scheduled:${cron.cronId}:${scheduledFor}`,
					agentId: cron.agentId,
					kind: "scheduled",
					sessionRecordId: session.sessionRecordId,
					sessionKey: session.sessionKey,
					createdAt: nowIso(),
					event: {
						eventType: "message.created",
						channelType: session.channelType,
						chatId: session.externalConversationId,
						chatKind: session.chatKind,
						chatTitle: session.chatTitle,
						messageId: `scheduled:${cron.cronId}:${scheduledFor}`,
						sender: {
							displayName: "Scheduler",
							externalId: "scheduler",
						},
						blocks: [{ kind: "text", text: `[Scheduled reminder due]\n${cron.message}` }],
						occurredAt: nowIso(),
					},
					scheduledReminder: {
						cronId: cron.cronId,
						message: cron.message,
						timezone: cron.timezone,
						scheduledFor,
					},
					});
					if (cron.scheduleKind === "once") {
						this.store.services.crons.completeCron(cron.cronId, nowIso());
					} else {
						this.store.services.crons.advanceDailyCron(cron.cronId, nowIso());
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					if (/Unknown session/.test(message)) {
						this.store.services.crons.invalidateCron(cron.cronId, "missing_session");
						continue;
					}
					this.store.audit(cron.agentId, "cron.poll_error", {
					cronId: cron.cronId,
					error: message,
				});
			}
		}
	}
}
