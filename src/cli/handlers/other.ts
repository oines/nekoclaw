import chalk from "chalk";
import { NEKOCLAW_NAME } from "../../config.js";
import { JsonNekoclawStore } from "../../store/json-store.js";
import type { AgentSpec, ChannelType } from "../../types.js";
import { requireValue, isRuntimeAlive } from "./shared.js";
import { collectReadinessIssues } from "./agent.js";
import { configureBuiltInModel, configureCustomModel } from "./model.js";
import type { QuickstartOptions } from "./shared.js";

export async function handleAdminAdd(
	agentRef: string,
	channelType: ChannelType,
	externalUserId: string,
	store: JsonNekoclawStore,
): Promise<void> {
	const agent = store.getAgentByRef(requireValue(agentRef, "agent"));
	const admin = store.addAdmin(agent.agentId, {
		channelType,
		externalUserId: requireValue(externalUserId, "user id"),
	});
	console.log(chalk.green(`Added admin ${admin.channelType}/${admin.externalUserId} to ${agent.slug}`));
}

import Table from "cli-table3";

export async function handleAdminList(agentRef: string, store: JsonNekoclawStore): Promise<void> {
	const agent = store.getAgentByRef(requireValue(agentRef, "agent"));
	const admins = store.listAdmins(agent.agentId);
	if (admins.length === 0) {
		console.log("No admins configured.");
		return;
	}
	const table = new Table({
		head: ["CHANNEL", "USER ID", "DISPLAY NAME", "ADDED AT"].map((h) => chalk.bold(h)),
		chars: { mid: "", "left-mid": "", "mid-mid": "", "right-mid": "" },
	});
	for (const admin of admins) {
		table.push([admin.channelType, admin.externalUserId, admin.displayName ?? "-", admin.addedAt]);
	}
	console.log(table.toString());
}

export async function handleAdminRemove(
	agentRef: string,
	channelType: ChannelType,
	externalUserId: string,
	store: JsonNekoclawStore,
): Promise<void> {
	const agent = store.getAgentByRef(requireValue(agentRef, "agent"));
	const admin = store.removeAdmin(agent.agentId, channelType, requireValue(externalUserId, "user id"));
	console.log(chalk.green(`Removed admin ${admin.channelType}/${admin.externalUserId} from ${agent.slug}`));
}

function collectDoctorIssues(agent: AgentSpec, store: JsonNekoclawStore): string[] {
	const issues = collectReadinessIssues(agent, store);
	if (!agent.enabled) {
		issues.push(`Agent is disabled. Run: ${NEKOCLAW_NAME} agent enable ${agent.slug}`);
	}
	if (agent.lastError) {
		issues.push(`Last error: ${agent.lastError}`);
	}
	return issues;
}

export async function handleDoctor(agentRef: string | undefined, store: JsonNekoclawStore): Promise<void> {
	const agents = agentRef ? [store.getAgentByRef(agentRef)] : store.listAgents();
	if (agents.length === 0) {
		console.log(`No agents yet. Run: ${NEKOCLAW_NAME} quickstart`);
		return;
	}
	for (const agent of agents) {
		console.log(chalk.bold(agent.slug));
		console.log(`  Model: ${agent.provider && agent.modelId ? `${agent.provider}/${agent.modelId}` : "not set"}`);
		const issues = collectDoctorIssues(agent, store);
		if (issues.length === 0) {
			console.log("  Healthy");
			continue;
		}
		for (const issue of issues) {
			console.log(`  - ${issue}`);
		}
	}
}

export async function handleStatus(store: JsonNekoclawStore): Promise<void> {
	const runtime = store.getRuntimeProcessState();
	const agents = store.listAgents();
	const enabledAgents = agents.filter((agent) => agent.enabled);
	const channels = agents.reduce((count, agent) => count + store.listChannels(agent.agentId).length, 0);
	const sessions = agents.reduce((count, agent) => count + store.listSessions(agent.agentId).length, 0);
	const runtimeAlive = isRuntimeAlive(runtime.pid);

	console.log(chalk.bold(`${NEKOCLAW_NAME} status`));
	console.log(`  Runtime: ${runtimeAlive ? "running" : "stopped"}`);
	console.log(`  PID: ${runtimeAlive ? runtime.pid : "-"}`);
	console.log(`  Updated: ${runtime.updatedAt}`);
	console.log(`  Agents: ${agents.length} total (${enabledAgents.length} enabled)`);
	console.log(`  Channels: ${channels}`);
	console.log(`  Sessions: ${sessions}`);
	console.log(
		`  Enabled agents: ${enabledAgents.length > 0 ? enabledAgents.map((agent) => agent.slug).join(", ") : "-"}`,
	);
}

import * as p from "@clack/prompts";
import { handleRuntimeStart } from "./runtime.js";
import { handleAgentEnable } from "./agent.js";
import { NekoclawDaemon } from "../../runtime/daemon.js";

export async function handleQuickstart(store: JsonNekoclawStore, options: QuickstartOptions): Promise<void> {
	const isInteractive = process.stdout.isTTY;
	p.intro(chalk.bgCyan.black(` ${NEKOCLAW_NAME} Quickstart `));

	const slug = (options.name ||
		(await p.text({
			message: "What is your agent's name?",
			placeholder: "cat-agent",
			validate: (v) => (!v ? "Name is required" : undefined),
		}))) as string;

	if (p.isCancel(slug)) {
		p.cancel("Operation cancelled");
		return;
	}

	const agent = store.createAgent({ slug });
	p.log.success(`Created agent workspace for "${agent.slug}"`);

	const modelMode = (options.source ||
		(options.baseUrl ? "custom" : options.provider ? "built-in" : undefined) ||
		(await p.select({
			message: "Select model source",
			options: [
				{ value: "built-in", label: "Built-in (OpenAI, Anthropic, etc.)" },
				{ value: "custom", label: "Custom (Self-hosted or Proxy)" },
			],
		}))) as string;

	if (p.isCancel(modelMode)) {
		p.cancel("Operation cancelled");
		return;
	}

	if (modelMode === "custom") {
		await configureCustomModel(agent.agentId, store, options);
	} else {
		await configureBuiltInModel(agent.agentId, store, options);
	}

	let channels: string[] = [];
	if (options.token) {
		channels = ["telegram"];
	} else if (isInteractive) {
		const selected = (await p.multiselect({
			message: "Which channels would you like to add?",
			options: [
				{ value: "telegram", label: "Telegram", hint: "Connect via Bot Token" },
				{ value: "napcat", label: "NapCat (QQ)", hint: "Connect via OneBot WebSocket" },
			],
			required: false,
		})) as string[];

		if (p.isCancel(selected)) {
			p.cancel("Operation cancelled");
			return;
		}
		channels = selected;
	}

	for (const type of channels) {
		store.createChannel(agent.agentId, type as ChannelType);
		p.log.success(`Added ${type} channel`);

		if (type === "telegram") {
			const token = (options.token ||
				(await p.password({
					message: "Enter Telegram Bot Token",
					validate: (v) => (!v ? "Token is required for Telegram" : undefined),
				}))) as string;
			if (!p.isCancel(token)) {
				store.setChannelToken(agent.agentId, "telegram", token);
			}
		} else if (type === "napcat") {
			const wsUrl = (await p.text({
				message: "Enter NapCat WebSocket URL",
				placeholder: "ws://localhost:3001",
				validate: (v) => (!v ? "URL is required for NapCat" : undefined),
			})) as string;
			const selfId = (await p.text({
				message: "Enter your Bot's QQ ID",
				validate: (v) => (!v ? "QQ ID is required for NapCat" : undefined),
			})) as string;
			if (!p.isCancel(wsUrl) && !p.isCancel(selfId)) {
				store.setNapcatEndpoint(agent.agentId, { wsUrl, selfId });
			}
		}
	}

	const startDaemon = isInteractive
		? await p.confirm({
				message: "Would you like to start the background runtime daemon now?",
				initialValue: true,
			})
		: false;

	if (startDaemon === true) {
		const s = p.spinner();
		s.start("Starting daemon...");
		await handleRuntimeStart(store);
		s.stop("Daemon started");
	}

	const enableAgent = isInteractive
		? await p.confirm({
				message: `Would you like to enable agent "${agent.slug}" now?`,
				initialValue: true,
			})
		: false;

	if (enableAgent === true) {
		const daemon = new NekoclawDaemon(store);
		await handleAgentEnable(agent.agentId, store, daemon);
		p.log.success(`Agent "${agent.slug}" enabled and ready!`);
	}

	p.outro(chalk.cyan("Quickstart complete! Have fun chatting."));
}
