import { inspectContainerStatus, ensureAgentContainer, removeAgentContainer, stopAgentContainer } from "./docker.js";
import type { ChannelPlugin } from "../types.js";
import { JsonNekoclawStore } from "../store/json-store.js";
import type { AgentSpec, ChannelType, InboundMessageEvent, PairRequest, RunJob } from "../types.js";
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

export class NekoclawDaemon {
	private channelPlugins = new Map<string, ChannelPlugin>();
	private agentQueues = new Map<string, RunJob[]>();
	private processingAgents = new Set<string>();
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

	constructor(private store: JsonNekoclawStore = new JsonNekoclawStore()) {
		this.outboundDispatch = new OutboundDispatchService(this.store, this.channelPlugins);
		this.workerRunner = new WorkerRunnerService(this.store, this.outboundDispatch, this.channelPlugins, (agentRef) => this.startAgentContainer(agentRef));
		this.jobQueue = new JobQueueService(this.store, this.agentQueues, this.processingAgents, (job) => this.workerRunner.runJob(job));
		const commands = new CommandRouterService(this.store, (agentId) => this.jobQueue.getStatus(agentId));
		this.messageRouter = new MessageRouterService(this.store, this.channelPlugins, commands, (job) => this.jobQueue.enqueue(job));
		this.channelRuntime = new ChannelRuntimeService(this.store, this.channelPlugins, getRuntimeKey, (agentId, channelType, event) =>
			this.messageRouter.handleInbound(agentId, channelType, event),
		);
		this.runtimeControl = new RuntimeControlService(this.store, this.channelPlugins, this.agentQueues, this.processingAgents);
	}

	async start(): Promise<void> {
		this.shuttingDown = false;
		this.stopPromise = undefined;
		this.jobQueue.initialize();
		await this.processRuntimeControlActions();
		await this.channelRuntime.syncAgents();
		this.syncTimer = setInterval(() => {
			void this.processRuntimeControlActions().then(() => this.channelRuntime.syncAgents());
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
		while (this.processingAgents.size > 0 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		this.jobQueue.compactIdleQueues();
		this.store.writeRuntimeProcessState({
			updatedAt: nowIso(),
		});
	}

	async startAgentContainer(agentRef: string): Promise<string> {
		const agent = this.store.getAgentByRef(agentRef);
		const status = await ensureAgentContainer(agent, this.store.getWorkspaceRoot(agent.slug));
		this.store.writeRuntimeState({
			...this.store.getRuntimeState(agent.agentId),
			agentId: agent.agentId,
			containerStatus: status,
			updatedAt: nowIso(),
		});
		return status;
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
}
