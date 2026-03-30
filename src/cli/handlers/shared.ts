import { createInterface } from "node:readline/promises";
import chalk from "chalk";
import { NEKOCLAW_NAME } from "../../config.js";
import type { AgentSpec, ChannelType } from "../../types.js";
import { JsonNekoclawStore } from "../../store/json-store.js";

export interface QuickstartOptions {
	name?: string;
	source?: string;
	provider?: string;
	model?: string;
	baseUrl?: string;
	providerId?: string;
	apiKey?: string;
	token?: string;
}

export interface AgentCreateOptions {}
export interface ForceOptions {
	force?: boolean;
}
export interface PurgeOptions {
	purge?: boolean;
}
export interface ChannelTokenOptions {
	token?: string;
}
export interface ChannelEndpointOptions {
	url?: string;
	selfId?: string;
}
export interface ChannelTriggerOptions {
	group?: "all" | "mention";
}
export interface PairListOptions {
	agent?: string;
}
export interface PairCodeOptions {
	code: string;
}
export interface ModelSetOptions {
	source?: string;
	provider?: string;
	model?: string;
	baseUrl?: string;
	providerId?: string;
	apiKey?: string;
}

export function requireValue(value: string | undefined, label: string): string {
	if (!value) {
		throw new Error(`Missing ${label}`);
	}
	return value;
}

export function isRuntimeAlive(pid: number | undefined): boolean {
	if (!pid) {
		return false;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export async function ask(question: string, fallback?: string): Promise<string> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const suffix = fallback ? ` [${fallback}]` : "";
	const answer = (await rl.question(`${question}${suffix}: `)).trim();
	rl.close();
	return answer || fallback || "";
}

export function printAgentRow(agent: AgentSpec, store: JsonNekoclawStore): void {
	const channels = store.listChannels(agent.agentId).length;
	const sessions = store.listSessions(agent.agentId).length;
	const model = agent.provider && agent.modelId ? `${agent.provider}/${agent.modelId}` : "-";
	const enabled = agent.enabled ? "yes" : "no";
	console.log(`${agent.slug}\t${enabled}\t${model}\t${channels}\t${sessions}\t${agent.lastError ?? "-"}`);
}

export function printAgentStatus(agent: AgentSpec, store: JsonNekoclawStore): void {
	console.log(chalk.bold(agent.slug));
	console.log(`  Enabled: ${agent.enabled ? "yes" : "no"}`);
	console.log(`  Model: ${agent.provider && agent.modelId ? `${agent.provider}/${agent.modelId}` : "not set"}`);
	console.log(`  Channels: ${store.listChannels(agent.agentId).length}`);
	console.log(`  Sessions: ${store.listSessions(agent.agentId).length}`);
	console.log(`  Last error: ${agent.lastError ?? "-"}`);
}
