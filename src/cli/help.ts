import { NEKOCLAW_NAME } from "../config.js";

function formatExamples(lines: string[]): string {
	return `\nExamples:\n${lines.map((line) => `  ${line}`).join("\n")}`;
}

export const TOP_LEVEL_HELP = `
Workflow:
  1. Quickstart: Create an agent and configure a provider/channel.
  2. Enable: Mark an agent as "ready to run".
  3. Start: Launch the background daemon to process messages.
  4. Pair: Link your Telegram/QQ chat to the agent.

Recommended start:
  ${NEKOCLAW_NAME} quickstart
  ${NEKOCLAW_NAME} agent enable <agent>
  ${NEKOCLAW_NAME} start
  Send a message to your bot to get a pairing code
  ${NEKOCLAW_NAME} pair accept --code <code>

Common commands:
  ${NEKOCLAW_NAME} start              Start the background daemon
  ${NEKOCLAW_NAME} status             Show daemon and agent summary
  ${NEKOCLAW_NAME} stop               Stop the background daemon
  ${NEKOCLAW_NAME} restart            Restart the background daemon
  ${NEKOCLAW_NAME} doctor cat-agent   Diagnose config or runtime issues
`;

export const QUICKSTART_HELP = `
The quickstart command guides you through creating an agent, setting up an AI provider,
and connecting a chat channel (Telegram or NapCat/QQ) in one go.

Parameters:
  --name        The unique name (slug) for your agent workspace.
  --source      "built-in" (OpenAI, etc.) or "custom" (self-hosted).
  --provider    Choose from: openai, anthropic, google, groq, cerebras, xai, 
                openrouter, mistral, minimax, kimi, together, deepseek.
  --token       For Telegram: Your BotFather API token.
                For NapCat: Your access token (if configured).

Examples:
  ${NEKOCLAW_NAME} quickstart
  ${NEKOCLAW_NAME} quickstart --name cat-agent --provider openai --model gpt-5 --token <bot-token>
`;

export const AGENT_HELP = `
Agents are isolated Docker environments.
  - list: Show all created agents.
  - status: Check if an agent is enabled, running, or has errors.
  - enable: Allow the daemon to start this agent's container.
  - disable: Stop the agent's container and take it offline.

Examples:
  ${NEKOCLAW_NAME} agent create cat-agent
  ${NEKOCLAW_NAME} agent enable cat-agent
  ${NEKOCLAW_NAME} agent status cat-agent
`;

export const AGENT_CREATE_HELP = formatExamples([
	`${NEKOCLAW_NAME} agent create cat-agent`,
]);

export const AGENT_ENABLE_HELP = `
Enabling an agent marks it as active. The background daemon ("nekoclaw start") 
will automatically spin up a Docker container for every enabled agent.

Examples:
  ${NEKOCLAW_NAME} agent enable cat-agent
  ${NEKOCLAW_NAME} start
`;

export const AGENT_DISABLE_HELP = formatExamples([
	`${NEKOCLAW_NAME} agent disable cat-agent`,
]);

export const AGENT_REMOVE_HELP = `
Deletes the agent's configuration. Note that by default, it won't allow
removal if there are active sessions or channels. Use --force to override.

Examples:
  ${NEKOCLAW_NAME} agent remove cat-agent
  ${NEKOCLAW_NAME} agent remove cat-agent --force
`;

export const ADMIN_HELP = `
Admins are identified by their platform-specific User ID. Only admins can
send control commands (like /status, /model, /reset) to the agent in chat.

How to find your ID:
  - Telegram: Use a bot like @userinfobot.
  - NapCat/QQ: Your numeric QQ number.

Examples:
  ${NEKOCLAW_NAME} admin add cat-agent telegram 123456789
  ${NEKOCLAW_NAME} admin list cat-agent
`;

export const MODEL_HELP = `
View or change the LLM configuration for an agent.
  - current: Show the active provider and model ID.
  - list: Fetch available models from the provider (if supported).
  - set: Change provider, model, API keys, or base URLs.

Examples:
  ${NEKOCLAW_NAME} model current cat-agent
  ${NEKOCLAW_NAME} model list cat-agent
`;

export const MODEL_SET_HELP = `
Configure the AI engine for your agent.

Built-in providers: 
  openai, anthropic, google, groq, cerebras, xai, openrouter, mistral, 
  minimax, kimi, together, deepseek, ollama, vllm, siliconflow.

Examples:
  ${NEKOCLAW_NAME} model set cat-agent --provider openai --model gpt-5 --api-key <key>
  ${NEKOCLAW_NAME} model set cat-agent --base-url http://localhost:11434/v1 --provider-id ollama --model llama3 --api-key <key>
`;

export const CHANNEL_HELP = `
Channels connect your agent to chat platforms.
  - telegram: Needs a Bot Token from @BotFather.
  - napcat: Connects to a NapCat/OneBot11 instance via WebSocket.

Examples:
  ${NEKOCLAW_NAME} channel add cat-agent telegram
  ${NEKOCLAW_NAME} channel token cat-agent telegram --token <bot-token>
  ${NEKOCLAW_NAME} channel endpoint cat-agent napcat --url ws://127.0.0.1:3001 --self-id <qq>
`;

export const CHANNEL_TOKEN_HELP = `
Securely saves the API or Access token for a specific channel.
For Telegram, this is the Bot Token. For NapCat, it's the optional access token.

Examples:
  ${NEKOCLAW_NAME} channel token cat-agent telegram --token <bot-token>
`;

export const PAIR_HELP = `
Pairing is how you authorize an agent to talk in a specific chat session.

Steps:
  1. Send any message to your bot on Telegram or QQ.
  2. The bot will reply with a 6-digit code (e.g., "123456").
  3. Run "${NEKOCLAW_NAME} pair accept --code 123456" here.

Examples:
  ${NEKOCLAW_NAME} pair list
  ${NEKOCLAW_NAME} pair accept --code 123456
`;

export const PAIR_ACCEPT_HELP = formatExamples([
	`${NEKOCLAW_NAME} pair accept --code 123456`,
]);

export const SESSION_HELP = `
A session represents a persistent link between an agent and a specific chat 
(a person or a group).

Examples:
  ${NEKOCLAW_NAME} session list cat-agent
  ${NEKOCLAW_NAME} session remove cat-agent <session-key>
`;

export const SESSION_REMOVE_HELP = `
Disconnects a chat from the agent. 
Use --purge to also delete the chat history and logs stored in the agent's workspace.

Examples:
  ${NEKOCLAW_NAME} session remove cat-agent <session-key> --purge
`;

export const DOCTOR_HELP = `
Runs a series of health checks for an agent, including:
  - Docker daemon availability.
  - AI Provider connectivity and API key validity.
  - Channel configuration and token status.
  - Runtime container logs and errors.

Examples:
  ${NEKOCLAW_NAME} doctor cat-agent
`;

export const STATUS_HELP = `
Shows if the background daemon is running and lists all agents with 
their current operational status (online/offline/error).

Examples:
  ${NEKOCLAW_NAME} status
`;

export const START_HELP = `
Starts the background daemon (nekoclaw runtime).
The daemon manages message routing and Docker container lifecycles.

Examples:
  ${NEKOCLAW_NAME} start
`;

export const STOP_HELP = `
Stops the background daemon. All active agent containers will also be shut down.

Examples:
  ${NEKOCLAW_NAME} stop
`;

export const RESTART_HELP = `
Stops and then starts the background daemon. Useful if you've updated 
global configurations or encountered runtime issues.

Examples:
  ${NEKOCLAW_NAME} restart
`;
