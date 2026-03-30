import { NEKOCLAW_NAME } from "../config.js";

function formatExamples(lines: string[]): string {
	return `\nExamples:\n${lines.map((line) => `  ${line}`).join("\n")}`;
}

export const TOP_LEVEL_HELP = `
Recommended start:
  ${NEKOCLAW_NAME} quickstart
  ${NEKOCLAW_NAME} agent enable <agent>
  ${NEKOCLAW_NAME} start
  Send a message to your bot to get a pairing code
  ${NEKOCLAW_NAME} pair accept --code <code>

Common examples:
  ${NEKOCLAW_NAME} quickstart
  ${NEKOCLAW_NAME} start
  ${NEKOCLAW_NAME} status
  ${NEKOCLAW_NAME} stop
  ${NEKOCLAW_NAME} restart
  ${NEKOCLAW_NAME} agent list
  ${NEKOCLAW_NAME} model set cat-agent --provider openai --model gpt-5
  ${NEKOCLAW_NAME} channel token cat-agent telegram --token <bot-token>
  ${NEKOCLAW_NAME} doctor cat-agent
`;

export const QUICKSTART_HELP = formatExamples([
	`${NEKOCLAW_NAME} quickstart`,
	`${NEKOCLAW_NAME} quickstart --name cat-agent --provider openai --model gpt-5 --token <bot-token>`,
	`${NEKOCLAW_NAME} quickstart --name cat-agent --source custom --base-url https://example.com/v1 --provider-id custom-ai --model claude-sonnet-4-6`,
]);

export const AGENT_HELP = formatExamples([
	`${NEKOCLAW_NAME} agent create cat-agent`,
	`${NEKOCLAW_NAME} agent enable cat-agent`,
	`${NEKOCLAW_NAME} start`,
	`${NEKOCLAW_NAME} agent status cat-agent`,
]);

export const AGENT_CREATE_HELP = formatExamples([
	`${NEKOCLAW_NAME} agent create cat-agent`,
]);

export const AGENT_ENABLE_HELP = formatExamples([
	`${NEKOCLAW_NAME} agent enable cat-agent`,
	`${NEKOCLAW_NAME} start`,
]);

export const AGENT_DISABLE_HELP = formatExamples([
	`${NEKOCLAW_NAME} agent disable cat-agent`,
]);

export const AGENT_REMOVE_HELP = formatExamples([
	`${NEKOCLAW_NAME} agent remove cat-agent`,
	`${NEKOCLAW_NAME} agent remove cat-agent --force`,
]);

export const ADMIN_HELP = formatExamples([
	`${NEKOCLAW_NAME} admin add cat-agent telegram 123456789`,
	`${NEKOCLAW_NAME} admin add cat-agent napcat 123456789`,
	`${NEKOCLAW_NAME} admin list cat-agent`,
	`${NEKOCLAW_NAME} admin remove cat-agent telegram 123456789`,
]);

export const MODEL_HELP = formatExamples([
	`${NEKOCLAW_NAME} model current cat-agent`,
	`${NEKOCLAW_NAME} model list cat-agent`,
	`${NEKOCLAW_NAME} model set cat-agent`,
]);

export const MODEL_SET_HELP = formatExamples([
	`${NEKOCLAW_NAME} model set cat-agent --provider openai --model gpt-5 --api-key <key>`,
	`${NEKOCLAW_NAME} model set cat-agent --base-url https://example.com/v1 --provider-id custom-ai --model claude-sonnet-4-6 --api-key <key>`,
	`${NEKOCLAW_NAME} model set cat-agent`,
]);

export const CHANNEL_HELP = formatExamples([
	`${NEKOCLAW_NAME} channel add cat-agent telegram`,
	`${NEKOCLAW_NAME} channel add cat-agent napcat`,
	`${NEKOCLAW_NAME} channel token cat-agent telegram --token <bot-token>`,
	`${NEKOCLAW_NAME} channel endpoint cat-agent napcat --url ws://127.0.0.1:3001 --self-id <qq>`,
	`${NEKOCLAW_NAME} channel list cat-agent`,
]);

export const CHANNEL_TOKEN_HELP = formatExamples([
	`${NEKOCLAW_NAME} channel token cat-agent telegram --token <bot-token>`,
	`${NEKOCLAW_NAME} channel token cat-agent napcat --token <access-token>`,
	`${NEKOCLAW_NAME} channel token cat-agent telegram`,
]);

export const PAIR_HELP = formatExamples([
	`${NEKOCLAW_NAME} pair list`,
	`${NEKOCLAW_NAME} pair accept --code 123456`,
	`${NEKOCLAW_NAME} pair reject --code 123456`,
]);

export const PAIR_ACCEPT_HELP = formatExamples([
	`${NEKOCLAW_NAME} pair accept --code 123456`,
]);

export const SESSION_HELP = formatExamples([
	`${NEKOCLAW_NAME} session list cat-agent`,
	`${NEKOCLAW_NAME} session remove cat-agent 123456789`,
]);

export const SESSION_REMOVE_HELP = formatExamples([
	`${NEKOCLAW_NAME} session remove cat-agent 123456789`,
	`${NEKOCLAW_NAME} session remove cat-agent 123456789 --purge`,
]);

export const DOCTOR_HELP = formatExamples([
	`${NEKOCLAW_NAME} doctor`,
	`${NEKOCLAW_NAME} doctor cat-agent`,
]);

export const STATUS_HELP = formatExamples([
	`${NEKOCLAW_NAME} status`,
]);

export const START_HELP = formatExamples([
	`${NEKOCLAW_NAME} start`,
]);

export const STOP_HELP = formatExamples([
	`${NEKOCLAW_NAME} stop`,
]);

export const RESTART_HELP = formatExamples([
	`${NEKOCLAW_NAME} restart`,
]);
