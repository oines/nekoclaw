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

import * as p from "@clack/prompts";

export async function ask(question: string, fallback?: string): Promise<string> {
	const answer = (await p.text({
		message: question,
		initialValue: fallback,
	})) as string;
	if (p.isCancel(answer)) {
		return fallback || "";
	}
	return answer || fallback || "";
}
