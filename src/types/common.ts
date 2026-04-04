export type ChannelType = "telegram" | "napcat";
export type ChatKind = "dm" | "group";
export type ModelApiFormat =
	| "openai-completions"
	| "anthropic-messages"
	| "openai-responses"
	| "openai-codex-responses"
	| "azure-openai-responses"
	| "google-generative-ai"
	| "google-gemini-cli"
	| "google-vertex"
	| "mistral-conversations"
	| "bedrock-converse-stream";
export const NEKOCLAW_CONFIG_VERSION = 1;
export type MessageEventType = "message.created" | "message.updated" | "message.deleted";
export type ReplyMode = "off" | "first" | "all";
export type GroupTriggerMode = "all" | "mention";
