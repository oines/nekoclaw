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

export async function handleAdminList(agentRef: string, store: JsonNekoclawStore): Promise<void> {
	const agent = store.getAgentByRef(requireValue(agentRef, "agent"));
	const admins = store.listAdmins(agent.agentId);
	if (admins.length === 0) {
		console.log("No admins configured.");
		return;
	}
	console.log("CHANNEL\tUSER ID\tDISPLAY NAME\tADDED AT");
	for (const admin of admins) {
		console.log(`${admin.channelType}\t${admin.externalUserId}\t${admin.displayName ?? "-"}\t${admin.addedAt}`);
	}
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

export async function handleQuickstart(store: JsonNekoclawStore, options: QuickstartOptions): Promise<void> {
	const { ask } = await import("./shared.js");
	const slug = options.name || (await ask("Agent name"));
	const agent = store.createAgent({ slug });
	console.log(chalk.green(`Created agent "${agent.slug}"`));

	const modelMode =
		options.source ||
		(options.baseUrl ? "custom" : options.provider ? "built-in" : undefined) ||
		(await ask("Model source (built-in/custom)", "built-in"));
	if (modelMode === "custom") {
		await configureCustomModel(agent.agentId, store, options);
	} else {
		await configureBuiltInModel(agent.agentId, store, options);
	}

	if (store.listChannels(agent.agentId).length === 0) {
		store.createChannel(agent.agentId, "telegram");
		console.log(chalk.green("Added Telegram channel"));
	}

	const token = options.token || (await ask("Telegram bot token"));
	if (token) {
		store.setChannelToken(agent.agentId, "telegram", token);
		console.log(chalk.green("Saved Telegram token"));
	}

	console.log(chalk.bold("\nNext step"));
	console.log(`${NEKOCLAW_NAME} agent enable ${agent.slug}`);
}
