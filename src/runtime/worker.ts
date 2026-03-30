import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	AuthStorage,
	codingTools,
	createAgentSession,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@mariozechner/pi-coding-agent";
import type { AssistantMessage, ImageContent } from "@mariozechner/pi-ai";
import { summarizeBlocks } from "../messages.js";
import { readTextFile } from "../store/fs.js";
import { createToolComposition } from "../tools/index.js";
import type { ChannelToolAction, WorkerPayload, WorkerResult } from "../types.js";

const WORKSPACE_DIR = "/workspace";

export function collectPromptImages(payload: WorkerPayload, workspaceDir: string): ImageContent[] {
	const images: ImageContent[] = [];
	for (const block of payload.job.event.blocks) {
		if (block.kind !== "image" || !block.attachment?.relativePath) {
			continue;
		}
		const mimeType = block.attachment.mimeType ?? block.mimeType;
		if (!mimeType?.startsWith("image/")) {
			continue;
		}
		const absolutePath = join(workspaceDir, block.attachment.relativePath);
		if (!existsSync(absolutePath)) {
			continue;
		}
		images.push({
			type: "image",
			data: readFileSync(absolutePath).toString("base64"),
			mimeType,
		});
	}
	return images;
}

export function buildAppendPrompt(payload: WorkerPayload, soul: string, memory: string): string {
	const identityLines = [
		payload.selfIdentity?.platformUserId
			? `- Your platform user id in this session: ${payload.selfIdentity.platformUserId}`
			: undefined,
		payload.selfIdentity?.telegramHandles?.length
			? `- You may be addressed in this session as: ${payload.selfIdentity.telegramHandles.join(", ")}`
			: undefined,
		payload.selfIdentity?.isExplicitlyAddressed
			? "- The current inbound message was already matched as being addressed to you by the routing layer."
			: undefined,
	].filter(Boolean);
	return `## Nekoclaw Workspace Contract
- You are replying inside a single paired session.
- Do not assume access to any other session.
- \`SOUL.md\` holds personality and voice.
- \`MEMORY.md\` holds durable facts and preferences.
- \`skills/\` contains reusable skills for this agent.
- \`chats/<sessionRecordId>/\` is only for this session's logs, context, attachments, and scratch files.

🟢 IMPORTANT FOR RESPONDING:
- To reply normally to the user, JUST OUTPUT RAW TEXT directly.
- DO NOT use the \`message\` tool for regular responses.
- ONLY use the \`message\` tool when explicitly needing to edit, delete, targeted replyToId, or simulate typing.
- Use the \`session_status\` tool to inspect current session capabilities before choosing a messaging action.
- Use the \`no_reply\` tool when the best action is to intentionally stay silent.

## Current Session
- Session key: ${payload.currentSession.sessionKey}
- Chat type: ${payload.currentSession.chatKind}
- External conversation id: ${payload.currentSession.externalConversationId}
- Parent session key: ${payload.currentSession.parentSessionKey ?? "(none)"}
${identityLines.length > 0 ? identityLines.join("\n") : ""}

## SOUL.md
${soul.trim() || "(empty)"}

## MEMORY.md
${memory.trim() || "(empty)"}`;
}



function buildPrompt(payload: WorkerPayload): string {
	const sender = [payload.job.event.sender.displayName, payload.job.event.sender.externalId].filter(Boolean).join(" / ");
	const lines = [
		payload.job.event.eventType ? `Event: ${payload.job.event.eventType}` : undefined,
		sender ? `Sender: ${sender}` : undefined,
		payload.job.event.replyToMessageId ? `Replying to message: ${payload.job.event.replyToMessageId}` : undefined,
		"Content:",
		...summarizeBlocks(payload.job.event.blocks),
	];
	return lines.filter(Boolean).join("\n");
}

function getLastAssistantText(
	payload: WorkerPayload,
	result: Awaited<ReturnType<typeof createAgentSession>>["session"]["state"],
): string {
	const lastMessage = result.messages[result.messages.length - 1];
	if (!lastMessage || lastMessage.role !== "assistant") {
		return "Done.";
	}
	const assistant = lastMessage as AssistantMessage;
	return assistant.content
		.filter((content) => content.type === "text")
		.map((content) => content.text)
		.join("\n")
		.trim();
}

async function bindPrintModeExtensions(
	session: Awaited<ReturnType<typeof createAgentSession>>["session"],
): Promise<void> {
	await session.bindExtensions({
		commandContextActions: {
			waitForIdle: () => session.agent.waitForIdle(),
			newSession: async () => ({ cancelled: true }),
			fork: async () => ({ cancelled: true }),
			navigateTree: async () => ({ cancelled: true }),
			switchSession: async () => ({ cancelled: true }),
			reload: async () => undefined,
		},
		onError: (err) => {
			console.error(`Nekoclaw worker extension error (${err.extensionPath}): ${err.error}`);
		},
	});
}

function overrideSessionPrompt(session: Awaited<ReturnType<typeof createAgentSession>>["session"], prompt: string) {
	session.agent.setSystemPrompt(prompt);
	const s = session as unknown as {
		_baseSystemPrompt?: string;
		_rebuildSystemPrompt?: () => string;
	};
	s._baseSystemPrompt = prompt;
	s._rebuildSystemPrompt = () => prompt;
}

export async function runWorker(payload: WorkerPayload): Promise<WorkerResult> {
	const runtimeAgentDir = join(WORKSPACE_DIR, ".nekoclaw-runtime");
	const settingsManager = SettingsManager.inMemory();
	const authStorage = AuthStorage.inMemory();
	const modelRegistry = new ModelRegistry(authStorage, join(runtimeAgentDir, "models.json"));
	const soul = readTextFile(join(WORKSPACE_DIR, "SOUL.md"), "");
	const memory = readTextFile(join(WORKSPACE_DIR, "MEMORY.md"), "");

	const finalSystemPrompt = buildAppendPrompt(payload, soul, memory);

	const resourceLoader = new DefaultResourceLoader({
		cwd: WORKSPACE_DIR,
		agentDir: runtimeAgentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		additionalSkillPaths: [join(WORKSPACE_DIR, "skills")],
		appendSystemPrompt: finalSystemPrompt,
	});
	await resourceLoader.reload();

	const contextPath = join(WORKSPACE_DIR, "chats", payload.currentSession.sessionRecordId, "context.jsonl");
	const sessionManager = SessionManager.create(WORKSPACE_DIR, dirname(contextPath));
	sessionManager.setSessionFile(contextPath);
	const toolActions: ChannelToolAction[] = [];
	const toolContext = {
		session: payload.currentSession,
		event: payload.job.event,
		capabilities: payload.capabilities,
		isExplicitlyAddressed: payload.selfIdentity?.isExplicitlyAddressed,
		recordAction: (action: ChannelToolAction) => {
			toolActions.push(action);
		},
	};
	const toolComposition = createToolComposition(toolContext);

	let model = undefined;
	if (payload.effectiveModel?.provider && payload.effectiveModel.modelId) {
		model = modelRegistry.find(payload.effectiveModel.provider, payload.effectiveModel.modelId);
		if (!model) {
			throw new Error(`Unknown model ${payload.effectiveModel.provider}/${payload.effectiveModel.modelId}`);
		}
	}

	const { session } = await createAgentSession({
		cwd: WORKSPACE_DIR,
		agentDir: runtimeAgentDir,
		authStorage,
		modelRegistry,
		settingsManager,
		sessionManager,
		resourceLoader,
		model,
		thinkingLevel: payload.effectiveModel?.thinkingLevel ?? payload.agent.thinkingLevel,
		tools: toolComposition.codingTools,
		customTools: toolComposition.customTools,
	});
	overrideSessionPrompt(session, finalSystemPrompt);
	await bindPrintModeExtensions(session);
	const images = collectPromptImages(payload, WORKSPACE_DIR);
	await session.prompt(buildPrompt(payload), images.length > 0 ? { images } : undefined);

	const responseText = getLastAssistantText(payload, session.state);
	const lastMessage = session.state.messages[session.state.messages.length - 1];
	const assistant = lastMessage?.role === "assistant" ? (lastMessage as AssistantMessage) : undefined;
	const suppressDefaultReply = toolActions.some((action) => action.kind === "no_reply");
	return {
		outbound: suppressDefaultReply
			? {}
			: {
					text: responseText,
				},
		toolActions,
		stopReason: assistant?.stopReason,
		errorMessage: assistant?.errorMessage,
	};
}

export async function runWorkerFromStdin(): Promise<void> {
	const chunks: string[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(String(chunk));
	}
	const payload = JSON.parse(chunks.join("")) as WorkerPayload;
	const result = await runWorker(payload);
	process.stdout.write(`${JSON.stringify(result)}\n`);
}
