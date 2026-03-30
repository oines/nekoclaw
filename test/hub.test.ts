import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("nekoclaw store", () => {
	let tempHome: string;
	const originalHome = process.env.HOME;

	beforeEach(() => {
		tempHome = mkdtempSync(join(tmpdir(), "nekoclaw-test-"));
		process.env.HOME = tempHome;
		vi.resetModules();
	});

	afterEach(() => {
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		rmSync(tempHome, { recursive: true, force: true });
	});

	it("stores product config in a single nekoclaw.json and keeps workspace session files separate", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { NEKOCLAW_CONFIG_PATH, NEKOCLAW_ROOT_DIR } = await import("../src/config.js");
		const store = new JsonNekoclawStore();

		const agent = store.createAgent({ slug: "cat-agent" });
		store.createChannel(agent.agentId, "telegram");
		store.setChannelToken(agent.agentId, "telegram", "telegram-secret");
		store.setBuiltinModelConfig(agent.agentId, {
			provider: "openai",
			modelId: "gpt-5",
			apiKey: "provider-secret",
		});
		const { session } = store.acceptPair(
			store.createOrReusePair(agent.agentId, {
				channelType: "telegram",
				externalConversationId: "12345",
				chatKind: "dm",
				senderId: "user-1",
				senderName: "Alice",
			}).code,
		);

		expect(existsSync(NEKOCLAW_CONFIG_PATH)).toBe(true);
		expect(existsSync(join(NEKOCLAW_ROOT_DIR, "agents"))).toBe(false);
		expect(existsSync(join(NEKOCLAW_ROOT_DIR, "channels"))).toBe(false);
		expect(existsSync(join(NEKOCLAW_ROOT_DIR, "chats"))).toBe(false);
		expect(existsSync(join(NEKOCLAW_ROOT_DIR, "secrets"))).toBe(false);
		expect(existsSync(join(NEKOCLAW_ROOT_DIR, "runtime", "pairs"))).toBe(true);

		const config = JSON.parse(readFileSync(NEKOCLAW_CONFIG_PATH, "utf-8")) as {
			version: number;
			agents: Record<string, any>;
			pairing: { ttlMinutes: number; repromptCooldownSeconds: number };
		};
		expect(config.version).toBe(1);
		expect(config.pairing.ttlMinutes).toBe(10);
		expect(config.agents["cat-agent"].model.provider).toBe("openai");
		expect(config.agents["cat-agent"].model.apiKey).toBe("provider-secret");
		expect(config.agents["cat-agent"].channels.telegram.token).toBe("telegram-secret");
		expect(config.agents["cat-agent"].sessions[session.sessionRecordId].externalConversationId).toBe("12345");
		expect(config.agents["cat-agent"].sessions[session.sessionRecordId].sessionKey).toBe("agent:cat-agent:telegram:direct:12345");

		const mode = statSync(NEKOCLAW_CONFIG_PATH).mode & 0o777;
		expect(mode).toBe(0o600);

		expect(existsSync(join(tempHome, ".nekoclaw", "workspaces", agent.slug, "SOUL.md"))).toBe(true);
		expect(existsSync(join(tempHome, ".nekoclaw", "workspaces", agent.slug, "AGENTS.md"))).toBe(true);
		expect(existsSync(join(tempHome, ".nekoclaw", "workspaces", agent.slug, "MEMORY.md"))).toBe(true);
		expect(existsSync(join(tempHome, ".nekoclaw", "workspaces", agent.slug, "skills"))).toBe(true);
		expect(existsSync(join(tempHome, ".nekoclaw", "workspaces", agent.slug, "skills", "skill-creator", "SKILL.md"))).toBe(true);
		expect(existsSync(join(tempHome, ".nekoclaw", "workspaces", agent.slug, "skills", "skill-creator", "references", "openai_yaml.md"))).toBe(true);
		expect(existsSync(join(tempHome, ".nekoclaw", "workspaces", agent.slug, "skills", "skill-creator", "scripts", "init_skill.py"))).toBe(true);
		expect(existsSync(join(tempHome, ".nekoclaw", "workspaces", agent.slug, ".nekoclaw-runtime"))).toBe(true);
		expect(session.sessionKey).toBe("agent:cat-agent:telegram:direct:12345");
		expect(session.externalConversationId).toBe("12345");
		expect(existsSync(join(tempHome, ".nekoclaw", "workspaces", agent.slug, "chats", session.sessionRecordId, "log.jsonl"))).toBe(true);
		expect(existsSync(join(tempHome, ".nekoclaw", "workspaces", agent.slug, "chats", session.sessionRecordId, "context.jsonl"))).toBe(true);
	});

	it("reuses the same session record when the same telegram conversation is paired again", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const store = new JsonNekoclawStore();
		const agent = store.createAgent({ slug: "cat-agent" });

		const first = store.createOrReusePair(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "12345",
			chatKind: "dm",
			senderId: "user-1",
		});
		const accepted = store.acceptPair(first.code);

		const second = store.createOrReusePair(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "12345",
			chatKind: "dm",
			senderId: "user-1",
		});
		const acceptedAgain = store.acceptPair(second.code);

		expect(acceptedAgain.session.sessionRecordId).toBe(accepted.session.sessionRecordId);
		expect(acceptedAgain.session.sessionKey).toBe("agent:cat-agent:telegram:direct:12345");
	});

	it("keeps custom model secrets out of workspace runtime metadata", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const { NEKOCLAW_CUSTOM_MODEL_API_KEY_ENV } = await import("../src/config.js");
		const store = new JsonNekoclawStore();

		const agent = store.createAgent({ slug: "proxy-agent" });
		const updatedAgent = store.setCustomModelConfig(agent.agentId, {
			baseUrl: "https://proxy.example/v1",
			api: "openai-completions",
			providerId: "custom-ai",
			modelId: "claude-sonnet-4-6",
			apiKey: "super-secret-key",
		});
		expect(updatedAgent.provider).toBe("custom-ai");
		store.writeRuntimeModelsConfig(agent.agentId, {
			providers: {
				[updatedAgent.provider!]: {
					baseUrl: "https://proxy.example/v1",
					api: "openai-completions",
					apiKey: NEKOCLAW_CUSTOM_MODEL_API_KEY_ENV,
					models: [{ id: "claude-sonnet-4-6" }],
				},
			},
		}, {});

		const runtimeConfig = readFileSync(store.getRuntimeModelsPath(agent.slug), "utf-8");
		expect(runtimeConfig).toContain(NEKOCLAW_CUSTOM_MODEL_API_KEY_ENV);
		expect(runtimeConfig).not.toContain("super-secret-key");

		const config = JSON.parse(readFileSync(join(tempHome, ".nekoclaw", "nekoclaw.json"), "utf-8")) as { agents: Record<string, any> };
		expect(config.agents["proxy-agent"].model.apiKey).toBe("super-secret-key");
		expect(config.agents["proxy-agent"].model.providerId).toBe(updatedAgent.provider);
	});

	it("requires explicit provider ids for custom models and keeps them distinct", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const store = new JsonNekoclawStore();

		const alpha = store.createAgent({ slug: "alpha-proxy" });
		const beta = store.createAgent({ slug: "beta-proxy" });
		const alphaModel = store.setCustomModelConfig(alpha.agentId, {
			baseUrl: "https://alpha.example/v1",
			api: "openai-completions",
			providerId: "alpha",
			modelId: "claude-sonnet-4-6",
		});
		const betaModel = store.setCustomModelConfig(beta.agentId, {
			baseUrl: "https://beta.example/v1",
			api: "openai-completions",
			providerId: "beta",
			modelId: "claude-sonnet-4-6",
		});

		expect(alphaModel.provider).toBe("alpha");
		expect(betaModel.provider).toBe("beta");
		expect(alphaModel.provider).not.toBe(betaModel.provider);
		expect(store.getAgentByRef(alpha.agentId).provider).toBe(alphaModel.provider);
		expect(store.getAgentByRef(beta.agentId).provider).toBe(betaModel.provider);
	});

	it("loads legacy custom configs that already have provider ids", async () => {
		const { NEKOCLAW_CONFIG_PATH } = await import("../src/config.js");
		mkdirSync(dirname(NEKOCLAW_CONFIG_PATH), { recursive: true });
		writeFileSync(
			NEKOCLAW_CONFIG_PATH,
			JSON.stringify(
				{
					version: 1,
					agents: {
						"legacy-custom": {
							agentId: "agent-legacy-custom",
							image: "node:22-bookworm-slim",
							enabled: false,
							model: {
								kind: "custom",
								baseUrl: "https://proxy.example/v1/",
								api: "openai-completions",
								providerId: "custom-ai",
								modelId: "claude-sonnet-4-6",
								apiKey: "legacy-secret",
							},
							channels: {},
							chats: {},
							createdAt: "2026-03-29T00:00:00.000Z",
							updatedAt: "2026-03-29T00:00:00.000Z",
						},
					},
					pairing: { ttlMinutes: 10, repromptCooldownSeconds: 60 },
				},
				null,
				2,
			),
		);

		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const store = new JsonNekoclawStore();
		const agent = store.getAgentByRef("legacy-custom");
		const model = store.getModelConfig(agent.agentId);

		expect(agent.provider).toBe("custom-ai");
		expect(model).toMatchObject({
			kind: "custom",
			providerId: "custom-ai",
			baseUrl: "https://proxy.example/v1",
			modelId: "claude-sonnet-4-6",
		});
	});

	it("persists an explicit provider id when a legacy custom config is re-saved", async () => {
		const { NEKOCLAW_CONFIG_PATH } = await import("../src/config.js");
		mkdirSync(dirname(NEKOCLAW_CONFIG_PATH), { recursive: true });
		writeFileSync(
			NEKOCLAW_CONFIG_PATH,
			JSON.stringify(
				{
					version: 1,
					agents: {
						"legacy-custom": {
							agentId: "agent-legacy-custom",
							image: "node:22-bookworm-slim",
							enabled: false,
							model: {
								kind: "custom",
								baseUrl: "https://proxy.example/v1/",
								api: "openai-completions",
								providerId: "custom-ai",
								modelId: "claude-sonnet-4-6",
								apiKey: "legacy-secret",
							},
							channels: {},
							chats: {},
							createdAt: "2026-03-29T00:00:00.000Z",
							updatedAt: "2026-03-29T00:00:00.000Z",
						},
					},
					pairing: { ttlMinutes: 10, repromptCooldownSeconds: 60 },
				},
				null,
				2,
			),
		);

		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const store = new JsonNekoclawStore();
		const agent = store.getAgentByRef("legacy-custom");
		const updatedAgent = store.setCustomModelConfig(agent.agentId, {
			baseUrl: "https://proxy.example/v1",
			api: "openai-completions",
			providerId: "custom-ai",
			modelId: "claude-sonnet-4-6",
			apiKey: "legacy-secret",
		});
		store.writeRuntimeModelsConfig(
			agent.agentId,
			{
				providers: {
					[updatedAgent.provider!]: {
						baseUrl: "https://proxy.example/v1",
						api: "openai-completions",
						models: [{ id: "claude-sonnet-4-6" }],
					},
				},
			},
			{ providerId: updatedAgent.provider },
		);

		const persisted = JSON.parse(readFileSync(NEKOCLAW_CONFIG_PATH, "utf-8")) as { agents: Record<string, any> };
		const runtimeConfig = JSON.parse(readFileSync(store.getRuntimeModelsPath(agent.slug), "utf-8")) as {
			providers: Record<string, unknown>;
		};

		expect(persisted.agents["legacy-custom"].model.providerId).toBe("custom-ai");
		expect(Object.keys(runtimeConfig.providers)).toEqual(["custom-ai"]);
	});

	it("derives child thread session keys without changing top-level telegram behavior", async () => {
		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const store = new JsonNekoclawStore();
		const agent = store.createAgent({ slug: "thread-cat" });

		const parent = store.createSession(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "12345",
			chatKind: "dm",
		});
		const child = store.createSession(agent.agentId, {
			channelType: "telegram",
			externalConversationId: "12345",
			chatKind: "dm",
			threadId: "thread-7",
			parentSessionKey: parent.sessionKey,
		});

		expect(parent.sessionKey).toBe("agent:thread-cat:telegram:direct:12345");
		expect(child.sessionKey).toBe("agent:thread-cat:telegram:direct:12345:thread:thread-7");
		expect(child.parentSessionKey).toBe(parent.sessionKey);
	});

	it("migrates legacy scattered config into nekoclaw.json and archives old directories", async () => {
		const { NEKOCLAW_ROOT_DIR, NEKOCLAW_LEGACY_AGENTS_DIR, NEKOCLAW_LEGACY_CHANNELS_DIR, NEKOCLAW_LEGACY_CHATS_DIR, NEKOCLAW_LEGACY_SECRETS_DIR, NEKOCLAW_CONFIG_PATH } =
			await import("../src/config.js");
		for (const dir of [NEKOCLAW_LEGACY_AGENTS_DIR, NEKOCLAW_LEGACY_CHANNELS_DIR, NEKOCLAW_LEGACY_CHATS_DIR, NEKOCLAW_LEGACY_SECRETS_DIR]) {
			mkdirSync(dir, { recursive: true });
		}

		const agentId = "agent-1";
		writeFileSync(
			join(NEKOCLAW_LEGACY_AGENTS_DIR, `${agentId}.json`),
			JSON.stringify(
				{
					agentId,
					slug: "legacy-agent",
					image: "node:22-bookworm-slim",
					containerName: "nekoclaw-legacy-agent",
					enabled: false,
					provider: "openai",
					modelId: "gpt-5",
					createdAt: "2026-03-29T00:00:00.000Z",
					updatedAt: "2026-03-29T00:00:00.000Z",
				},
				null,
				2,
			),
		);
		writeFileSync(
			join(NEKOCLAW_LEGACY_CHANNELS_DIR, `${agentId}-telegram.json`),
			JSON.stringify(
				{
					agentId,
					type: "telegram",
					createdAt: "2026-03-29T00:00:00.000Z",
					updatedAt: "2026-03-29T00:00:00.000Z",
				},
				null,
				2,
			),
		);
		writeFileSync(
			join(NEKOCLAW_LEGACY_CHATS_DIR, `chat-1.json`),
			JSON.stringify(
				{
					sessionRecordId: "chat-1",
					agentId,
					channelType: "telegram",
					externalConversationId: "999",
					chatKind: "dm",
					status: "active",
					createdAt: "2026-03-29T00:00:00.000Z",
					updatedAt: "2026-03-29T00:00:00.000Z",
				},
				null,
				2,
			),
		);
		writeFileSync(
			join(NEKOCLAW_LEGACY_SECRETS_DIR, `${agentId}.json`),
			JSON.stringify(
				{
					channelTokens: { telegram: "telegram-secret" },
					providerKeys: { openai: "provider-secret" },
				},
				null,
				2,
			),
		);

		const { JsonNekoclawStore } = await import("../src/store/json-store.js");
		const store = new JsonNekoclawStore();

		expect(store.listAgents()).toHaveLength(1);
		expect(existsSync(NEKOCLAW_CONFIG_PATH)).toBe(true);
		const config = JSON.parse(readFileSync(NEKOCLAW_CONFIG_PATH, "utf-8")) as { agents: Record<string, any> };
		expect(config.agents["legacy-agent"].model.apiKey).toBe("provider-secret");
		expect(config.agents["legacy-agent"].channels.telegram.token).toBe("telegram-secret");
		expect(config.agents["legacy-agent"].sessions["chat-1"].externalConversationId).toBe("999");
		expect(config.agents["legacy-agent"].sessions["chat-1"].sessionKey).toBe("agent:legacy-agent:telegram:direct:999");

		const legacyBackups = readdirSync(NEKOCLAW_ROOT_DIR).filter((entry) => entry.startsWith("legacy-config-"));
		expect(legacyBackups.length).toBe(1);
		expect(existsSync(NEKOCLAW_LEGACY_AGENTS_DIR)).toBe(false);
		expect(existsSync(NEKOCLAW_LEGACY_CHANNELS_DIR)).toBe(false);
		expect(existsSync(NEKOCLAW_LEGACY_CHATS_DIR)).toBe(false);
		expect(existsSync(NEKOCLAW_LEGACY_SECRETS_DIR)).toBe(false);
	});
});
