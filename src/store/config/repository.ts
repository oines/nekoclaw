import { NEKOCLAW_CONFIG_PATH, ensureNekoclawLayout } from "../../config.js";
import type { AgentConfig, NekoclawConfig } from "../../types.js";
import { withFileLock, readJsonFile, writeJsonFile } from "../fs.js";
import { defaultConfig } from "./defaults.js";
import { migrateLegacyConfigIfNeeded } from "./migration.js";
import { normalizeConfig } from "./normalize.js";
import { StorePaths } from "../paths.js";

export class ConfigRepository {
	constructor(private readonly paths: StorePaths) {
		ensureNekoclawLayout();
		migrateLegacyConfigIfNeeded(this.paths);
	}

	readConfig(): NekoclawConfig {
		return normalizeConfig(readJsonFile<Partial<NekoclawConfig>>(NEKOCLAW_CONFIG_PATH, defaultConfig()));
	}

	updateConfig<T>(updater: (config: NekoclawConfig) => T): T {
		return withFileLock(NEKOCLAW_CONFIG_PATH, () => {
			const config = this.readConfig();
			const result = updater(config);
			writeJsonFile(NEKOCLAW_CONFIG_PATH, config, { mode: 0o600, skipLock: true });
			return result;
		});
	}

	getAgentEntry(ref: string): { slug: string; config: AgentConfig } {
		const config = this.readConfig();
		for (const [slug, agent] of Object.entries(config.agents)) {
			if (slug === ref || agent.agentId === ref) {
				return { slug, config: agent };
			}
		}
		throw new Error(`Unknown agent "${ref}"`);
	}

	getAgentEntryById(agentId: string): { slug: string; config: AgentConfig } {
		return this.getAgentEntry(agentId);
	}
}
