import type { NekoclawConfig, PairingConfig } from "../../types.js";
import { NEKOCLAW_CONFIG_VERSION } from "../../types.js";

export function defaultPairingConfig(): PairingConfig {
	return {
		ttlMinutes: 10,
		repromptCooldownSeconds: 60,
	};
}

export function defaultConfig(): NekoclawConfig {
	return {
		version: NEKOCLAW_CONFIG_VERSION,
		agents: {},
		pairing: defaultPairingConfig(),
	};
}
