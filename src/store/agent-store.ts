import { randomUUID } from "node:crypto";
import { cpSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AdminIdentity, AgentConfig, AgentSpec, ChannelType } from "../types.js";
import { readTextFile, writeTextFile } from "./fs.js";
import { ConfigRepository } from "./config-repository.js";
import {
	defaultAgents,
	defaultSoul,
	ensureDir,
	fallbackSkillCreator,
	getBuiltInSkillCreatorPath,
	normalizeAgentSpec,
	normalizeTextForWrite,
	nowIso,
	slugify,
} from "./helpers.js";
import { StorePaths } from "./paths.js";

export interface CreateAgentInput {
	slug: string;
	image?: string;
}

export interface UpdateAgentInput {
	image?: string;
	enabled?: boolean;
	lastError?: string | null;
}

export class AgentStore {
	constructor(
		private readonly repo: ConfigRepository,
		private readonly paths: StorePaths,
	) {}

	listAgents(): AgentSpec[] {
		const config = this.repo.readConfig();
		return Object.entries(config.agents)
			.map(([slug, agent]) => normalizeAgentSpec(slug, agent))
			.sort((a, b) => a.slug.localeCompare(b.slug));
	}

	getAgentByRef(ref: string): AgentSpec {
		const { slug, config } = this.repo.getAgentEntry(ref);
		return normalizeAgentSpec(slug, config);
	}

	createAgent(input: CreateAgentInput): AgentSpec {
		const slug = slugify(input.slug);
		if (!slug) {
			throw new Error("Agent name must contain letters or numbers");
		}
		const timestamp = nowIso();
		const agent = this.repo.updateConfig((config) => {
			if (config.agents[slug]) {
				throw new Error(`Agent "${slug}" already exists`);
			}
			const created: AgentConfig = {
				agentId: randomUUID(),
				image: input.image?.trim() || "node:22-bookworm-slim",
				enabled: false,
				channels: {},
				sessions: {},
				admins: [],
				createdAt: timestamp,
				updatedAt: timestamp,
			};
			config.agents[slug] = created;
			return normalizeAgentSpec(slug, created);
		});
		this.ensureWorkspace(agent);
		return agent;
	}

	updateAgent(ref: string, patch: UpdateAgentInput): AgentSpec {
		return this.repo.updateConfig((config) => {
			for (const [slug, current] of Object.entries(config.agents)) {
				if (slug !== ref && current.agentId !== ref) {
					continue;
				}
				current.image = patch.image !== undefined ? patch.image : current.image;
				current.enabled = patch.enabled ?? current.enabled;
				current.lastError = patch.lastError === null ? undefined : patch.lastError !== undefined ? patch.lastError : current.lastError;
				current.updatedAt = nowIso();
				return normalizeAgentSpec(slug, current);
			}
			throw new Error(`Unknown agent "${ref}"`);
		});
	}

	deleteAgentConfig(ref: string): AgentSpec {
		const agent = this.getAgentByRef(ref);
		this.repo.updateConfig((config) => {
			delete config.agents[agent.slug];
		});
		return agent;
	}

	listAdmins(agentRef: string): AdminIdentity[] {
		const { config } = this.repo.getAgentEntry(agentRef);
		return [...config.admins].sort((a, b) =>
			`${a.channelType}:${a.externalUserId}`.localeCompare(`${b.channelType}:${b.externalUserId}`),
		);
	}

	addAdmin(
		agentRef: string,
		input: {
			channelType: ChannelType;
			externalUserId: string;
			displayName?: string;
		},
	): AdminIdentity {
		const { slug } = this.repo.getAgentEntry(agentRef);
		const channelType = input.channelType;
		const externalUserId = input.externalUserId.trim();
		if (!externalUserId) {
			throw new Error("Admin user id is required");
		}
		const displayName = input.displayName?.trim() || undefined;
		return this.repo.updateConfig((config) => {
			const agent = config.agents[slug];
			const existing = agent.admins.find(
				(admin) => admin.channelType === channelType && admin.externalUserId === externalUserId,
			);
			if (existing) {
				if (displayName && existing.displayName !== displayName) {
					existing.displayName = displayName;
					agent.updatedAt = nowIso();
				}
				return { ...existing };
			}
			const admin: AdminIdentity = {
				channelType,
				externalUserId,
				displayName,
				addedAt: nowIso(),
			};
			agent.admins.push(admin);
			agent.updatedAt = nowIso();
			return admin;
		});
	}

	removeAdmin(agentRef: string, channelType: ChannelType, externalUserId: string): AdminIdentity {
		const { slug } = this.repo.getAgentEntry(agentRef);
		const trimmedUserId = externalUserId.trim();
		if (!trimmedUserId) {
			throw new Error("Admin user id is required");
		}
		return this.repo.updateConfig((config) => {
			const agent = config.agents[slug];
			const index = agent.admins.findIndex(
				(admin) => admin.channelType === channelType && admin.externalUserId === trimmedUserId,
			);
			if (index < 0) {
				throw new Error(`Admin ${channelType}/${trimmedUserId} is not configured`);
			}
			const [removed] = agent.admins.splice(index, 1);
			agent.updatedAt = nowIso();
			return removed;
		});
	}

	isAdmin(agentRef: string, channelType: ChannelType, externalUserId?: string): boolean {
		if (!externalUserId) {
			return false;
		}
		const { config } = this.repo.getAgentEntry(agentRef);
		return config.admins.some(
			(admin) => admin.channelType === channelType && admin.externalUserId === externalUserId,
		);
	}

	removeWorkspace(slug: string): void {
		rmSync(this.paths.getWorkspaceRoot(slug), { recursive: true, force: true });
	}

	readSoul(agentRef: string): string {
		const agent = this.getAgentByRef(agentRef);
		return readTextFile(this.paths.getSoulPath(agent.slug), "");
	}

	readAgents(agentRef: string): string {
		const agent = this.getAgentByRef(agentRef);
		return readTextFile(this.paths.getAgentsPath(agent.slug), "");
	}

	writeSoul(agentRef: string, content: string): void {
		const agent = this.getAgentByRef(agentRef);
		writeTextFile(this.paths.getSoulPath(agent.slug), normalizeTextForWrite(content));
	}

	readMemory(agentRef: string): string {
		const agent = this.getAgentByRef(agentRef);
		return readTextFile(this.paths.getMemoryPath(agent.slug), "");
	}

	writeMemory(agentRef: string, content: string): void {
		const agent = this.getAgentByRef(agentRef);
		writeTextFile(this.paths.getMemoryPath(agent.slug), normalizeTextForWrite(content));
	}

	getWorkspaceRoot(slug: string): string {
		return this.paths.getWorkspaceRoot(slug);
	}

	getSoulPath(slug: string): string {
		return this.paths.getSoulPath(slug);
	}

	getAgentsPath(slug: string): string {
		return this.paths.getAgentsPath(slug);
	}

	getMemoryPath(slug: string): string {
		return this.paths.getMemoryPath(slug);
	}

	getSkillsDir(slug: string): string {
		return this.paths.getSkillsDir(slug);
	}

	getRuntimeAgentDir(slug: string): string {
		return this.paths.getRuntimeAgentDir(slug);
	}

	private ensureWorkspace(agent: AgentSpec): void {
		const root = this.paths.getWorkspaceRoot(agent.slug);
		ensureDir(root);
		ensureDir(this.paths.getSkillsDir(agent.slug));
		ensureDir(this.paths.getRuntimeAgentDir(agent.slug));
		ensureDir(join(root, "chats"));

		if (!existsSync(this.paths.getSoulPath(agent.slug))) {
			writeTextFile(this.paths.getSoulPath(agent.slug), defaultSoul(agent));
		}
		if (!existsSync(this.paths.getAgentsPath(agent.slug))) {
			writeTextFile(this.paths.getAgentsPath(agent.slug), defaultAgents(agent));
		}
		if (!existsSync(this.paths.getMemoryPath(agent.slug))) {
			writeTextFile(this.paths.getMemoryPath(agent.slug), "");
		}
		this.installBuiltInSkills(agent.slug);
	}

	private installBuiltInSkills(slug: string): void {
		const targetDir = join(this.paths.getSkillsDir(slug), "skill-creator");
		if (existsSync(targetDir)) {
			return;
		}
		const sourceDir = getBuiltInSkillCreatorPath();
		if (existsSync(sourceDir)) {
			cpSync(sourceDir, targetDir, { recursive: true });
			return;
		}
		ensureDir(targetDir);
		writeTextFile(join(targetDir, "SKILL.md"), fallbackSkillCreator());
	}
}
