import chalk from "chalk";
import { NekoclawDaemon } from "../../runtime/daemon.js";
import { JsonNekoclawStore } from "../../store/json-store.js";
import { NEKOCLAW_NAME } from "../../config.js";
import type { AgentSpec } from "../../types.js";
import { ask, printAgentRow, printAgentStatus, requireValue, type AgentCreateOptions, type ForceOptions } from "./shared.js";
import { requestBackgroundRuntimeRemoval } from "./runtime.js";

function getModelConfig(agent: AgentSpec, store: JsonNekoclawStore) {
	return store.getModelConfig(agent.agentId);
}

export function collectReadinessIssues(agent: AgentSpec, store: JsonNekoclawStore): string[] {
	const issues: string[] = [];
	const modelConfig = getModelConfig(agent, store);
	if (!agent.provider || !agent.modelId) {
		issues.push(`No model configured. Run: ${NEKOCLAW_NAME} model set ${agent.slug}`);
	} else if (modelConfig?.kind === "custom") {
		if (!store.getCustomModelApiKey(agent.agentId)) {
			issues.push(`No API key saved for custom model source. Run: ${NEKOCLAW_NAME} model set ${agent.slug}`);
		}
		if (!store.readRuntimeModelsConfig(agent.agentId)) {
			issues.push(`Custom model metadata is missing. Run: ${NEKOCLAW_NAME} model set ${agent.slug}`);
		}
	} else if (!store.getProviderKey(agent.agentId, agent.provider)) {
		issues.push(`No API key saved for provider ${agent.provider}. Run: ${NEKOCLAW_NAME} model set ${agent.slug}`);
	}

	const channels = store.listChannels(agent.agentId);
	if (channels.length === 0) {
		issues.push(`No channel configured. Run: ${NEKOCLAW_NAME} channel add ${agent.slug} telegram`);
	}
	for (const channel of channels) {
		if (channel.type === "telegram") {
			if (!store.getChannelToken(agent.agentId, "telegram")) {
				issues.push(`No Telegram token. Run: ${NEKOCLAW_NAME} channel token ${agent.slug} telegram`);
			}
			continue;
		}
		const config = store.getNapcatChannelConfig(agent.agentId);
		if (!config?.wsUrl) {
			issues.push(`No NapCat endpoint. Run: ${NEKOCLAW_NAME} channel endpoint ${agent.slug} napcat --url <ws-url> --self-id <qq>`);
		}
		if (!config?.selfId) {
			issues.push(`No NapCat self id. Run: ${NEKOCLAW_NAME} channel endpoint ${agent.slug} napcat --url <ws-url> --self-id <qq>`);
		}
	}
	return issues;
}

export async function handleAgentCreate(name: string, _options: AgentCreateOptions, store: JsonNekoclawStore): Promise<void> {
	const agent = store.createAgent({
		slug: requireValue(name, "agent name"),
	});
	printAgentStatus(agent, store);
	console.log(`Next: ${NEKOCLAW_NAME} model set ${agent.slug}`);
}

export async function handleAgentList(store: JsonNekoclawStore): Promise<void> {
	const agents = store.listAgents();
	if (agents.length === 0) {
		console.log(`No agents yet. Run: ${NEKOCLAW_NAME} quickstart`);
		return;
	}
	console.log("NAME\tENABLED\tMODEL\tCHANNELS\tSESSIONS\tLAST ERROR");
	for (const agent of agents) {
		printAgentRow(agent, store);
	}
}

export async function handleAgentStatus(agentRef: string, store: JsonNekoclawStore): Promise<void> {
	printAgentStatus(store.getAgentByRef(requireValue(agentRef, "agent")), store);
}

export async function handleAgentEnable(agentRef: string, store: JsonNekoclawStore, _daemon: NekoclawDaemon): Promise<void> {
	const current = store.getAgentByRef(requireValue(agentRef, "agent"));
	const issues = collectReadinessIssues(current, store);
	if (issues.length > 0) {
		throw new Error(issues.join("\n"));
	}
	const agent = store.updateAgent(agentRef, { enabled: true, lastError: null });
	console.log(chalk.green(`${agent.slug} is now enabled`));
	console.log(`Run "${NEKOCLAW_NAME} start" to bring enabled agents online.`);
}

export async function handleAgentDisable(agentRef: string, store: JsonNekoclawStore, daemon: NekoclawDaemon): Promise<void> {
	const agent = store.updateAgent(requireValue(agentRef, "agent"), { enabled: false });
	await daemon.stopAgentContainer(agent.agentId);
	console.log(chalk.green(`${agent.slug} is now disabled`));
}

export async function handleAgentRemove(agentRef: string, options: ForceOptions, store: JsonNekoclawStore, daemon: NekoclawDaemon): Promise<void> {
	const agent = store.getAgentByRef(requireValue(agentRef, "agent"));
	const activeChannels = store.listChannels(agent.agentId);
	const activeSessions = store.listSessions(agent.agentId);
	if (!options.force && (activeChannels.length > 0 || activeSessions.length > 0)) {
		throw new Error(`Agent "${agent.slug}" still has channels or sessions. Use --force to remove it.`);
	}
	const removedByBackground = await requestBackgroundRuntimeRemoval(store, agent);
	if (!removedByBackground) {
		await daemon.removeAgentRuntime(agent);
	}
	const removed = store.deleteAgent(agent.agentId, { force: true });
	console.log(chalk.green(`Removed agent ${removed.slug}`));
}
