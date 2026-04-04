import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
	AuthStorage,
	codingTools,
	createAgentSession,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@mariozechner/pi-coding-agent";
import type { AssistantMessage, ImageContent, Message, UserMessage } from "@mariozechner/pi-ai";
import type { Api, Model } from "@mariozechner/pi-ai";
import { summarizeBlocks } from "../messages.js";
import type { RuntimeModelsConfig } from "../model/model-types.js";
import { resolveRuntimeModelInput } from "../model/runtime-model-metadata.js";
import { SESSION_COMPACTION_SETTINGS, shapeSessionMessagesForPrompt } from "./session-hygiene.js";
import { readTextFile } from "../store/fs.js";
import { createToolComposition } from "../tools/index.js";
import type { ChannelToolAction, WorkerPayload, WorkerResult } from "../types.js";

const WORKSPACE_DIR = "/workspace";

export function collectPromptImages(
	payload: WorkerPayload,
	workspaceDir: string,
	recentHistory: (UserMessage | AssistantMessage)[],
): ImageContent[] {
	const images: ImageContent[] = [];
	const seenPaths = new Set<string>();

	function addImage(relativePath: string, mimeType?: string) {
		const absolutePath = join(workspaceDir, relativePath);
		if (!seenPaths.has(absolutePath) && existsSync(absolutePath)) {
			seenPaths.add(absolutePath);
			images.push({
				type: "image",
				data: readFileSync(absolutePath).toString("base64"),
				mimeType: mimeType || "image/jpeg",
			});
		}
	}

	// 1. Scan current message blocks
	for (const block of payload.job.event.blocks) {
		if (block.kind === "image" && block.attachment?.relativePath) {
			addImage(block.attachment.relativePath, block.attachment.mimeType ?? block.mimeType);
		}
	}

	// 2. If current turn has no images, or for better context, scan recent history (last 5 messages)
	// This helps when user says "what's in that picture?" in the next turn.
	if (images.length === 0) {
		const contextSearchRange = recentHistory.slice(-5);
		for (const msg of contextSearchRange) {
			if (msg.role === "user" && typeof msg.content === "string") {
				// Look for path patterns in the summarized text blocks like "Image: attachments/..."
				const matches = msg.content.matchAll(/Image: ([^\n\s]+\.(?:jpg|jpeg|png|webp|gif))/gi);
				for (const match of matches) {
					if (match[1]) {
						addImage(match[1]);
					}
				}
			}
		}
	}

	return images;
}

export function buildAppendPrompt(payload: WorkerPayload, soul: string, memory: string): string {
	const hasCurrentImages = payload.job.event.blocks.some((block) => block.kind === "image");
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
	const personaSections = payload.personaContext
		? [
				payload.personaContext.indexMarkdown
					? `## Persona Index
${payload.personaContext.indexMarkdown}`
					: "",
				payload.personaContext.selectedMemoryMarkdowns.length > 0
					? `## Selected Persona Memories
${payload.personaContext.selectedMemoryMarkdowns
	.map(
		(entry) =>
			`### ${entry.path}
- Kind: ${entry.kind}
- Title: ${entry.title || "(untitled)"}
- Description: ${entry.description || "(no description)"}

${entry.markdown}`,
	)
	.join("\n\n")}`
					: "",
				payload.personaContext.sceneObservations
					? `## Current Scene Observations
${payload.personaContext.sceneObservations}`
					: "",
			]
				.filter(Boolean)
				.join("\n\n")
		: "";
	return `## Nekoclaw Workspace Contract
- You are replying inside a single paired session.
- Do not assume access to any other session.
- \`SOUL.md\` holds personality and voice.
- \`MEMORY.md\` holds durable facts and preferences.
- \`skills/\` contains reusable skills for this agent.
- \`chats/<sessionRecordId>/\` is only for this session's logs, context, attachments, and scratch files.

## Response Order
- First decide whether this turn is a normal current-session reply, a current-session advanced action, a cross-session proactive message, or a session reminder workflow.
- For a normal reply in the current session, JUST OUTPUT RAW TEXT directly.
- Do not call a tool when plain text already solves the current reply.

## Tool Routing
- Use the \`message\` tool only for advanced actions in the current session: explicit send/reply/edit/delete/typing.
- Use the \`send_message\` tool only when you need to proactively contact another known person or group outside the current session.
- Use the \`cron\` tool only for reminders bound to this current session. Never invent or ask for a session key.
- Use the \`session_status\` tool when you need to confirm current-session capabilities before choosing an action.
- Use \`list_contacts\`, \`list_groups\`, \`get_group_members\`, and \`get_contact_detail\` only to inspect the runtime-known directory before proactive outreach.
- Use the \`no_reply\` tool only when silence is intentionally the best outcome.
- Routing examples:
- Reply to the current user normally -> output plain text.
- Reply to a specific earlier message in this same chat -> \`message(action='reply', ...)\`.
- Proactively message another known DM or group -> \`send_message(target, ...)\`.

## Persona Strategy
- \`SOUL.md\` is the primary source for your style, voice, and personality.
- Runtime rules constrain behavior and tool usage; they do not replace your voice.
- If Persona memory context is present, treat it as the authoritative memory substrate for people and past events.
- The persona index is your routing map and default memory context: check \`index.md\` first, then read the 1-3 most relevant detailed files it points to when the answer depends on specifics.
- If the user asks about prior conversations, memory, identity, promises, defaults, people, scenes, or "what happened before", treat that as a strong cue to inspect persona memory instead of answering from vague impression.
- Strong recall triggers include phrases like "还记得", "上次", "之前", "后来", "我是谁", "那个人", "那个群", "默认按哪个", "你答应过什么", and similar callbacks to earlier context.
- If a relevant detail file exists and could verify the answer, use the built-in \`read\` tool to open the specific path referenced in \`index.md\` under \`.nekoclaw-persona/memory/\` before answering.
- Do not guess or rely on index-level summaries alone when the user is asking for detail that a referenced memory file can confirm.
- When useful, combine 1 person file plus 1 scene file so you can answer both who someone is and where/when that information came up.
- Current Scene Observations are recent passive observations (旁观记录). If you refer to them, make it explicit when you were only observing rather than participating.
- Current Scene Observations are already injected for you, so you do not need to manually read observations/ files.
- If Current Scene Observations already contain the answer, summarize those observed facts directly instead of stalling, deflecting, or asking the user to repeat them.
- Do not invent facts beyond what Persona memories or Current Scene Observations support. If evidence is partial, answer the supported part and mark the rest as uncertain.
- Never turn passive observations into "we discussed" or other participation claims. Keep source distinctions explicit.
- For recall questions like "群里刚才在聊什么", "还记得", "上次", or "最近忙的那些事", answer the facts first. Do not lead with cute filler, roleplay deflection, or a request for the user to remind you when evidence is already present.
- Preserve source distinctions: say whether something came from your own participation, passive observation, or a memory file you just checked.
- Preserve uncertainty markers from the evidence ("可能", "应该", etc.) instead of upgrading them into certainty.
- Examples:
- The user asks "上次数据库选型那个事你还记得吗" -> check \`index.md\`, then read the referenced person/scene file before answering.
- The user asks "你之前答应过我默认用哪个方案" -> read the relevant memory file; do not answer from vibe or only the index summary.
- The user asks "那个群里后来怎么说的" -> prefer the scene file, and make clear whether you personally participated or only observed.
- The user asks "我是谁" or corrects identity -> verify the linked person file and preserve uncertainty if identity is still not fully confirmed.
${hasCurrentImages
	? `- The current inbound message includes image content. Answer with direct visual facts first.
- Do NOT use placeholder templates, bracketed fill-ins, canned admiration, or speculative scene descriptions.
- Do NOT write phrases like "[此处根据图片内容描述]" / "例如" / "比如" as stand-ins.
- If something is unclear, say exactly which detail is unclear instead of guessing.`
	: ""}

## Current Session
- Session key: ${payload.currentSession.sessionKey}
- Chat type: ${payload.currentSession.chatKind}
- External conversation id: ${payload.currentSession.externalConversationId}
- Parent session key: ${payload.currentSession.parentSessionKey ?? "(none)"}
- Server local timezone: ${payload.serverTimezone}
${identityLines.length > 0 ? identityLines.join("\n") : ""}

${personaSections}

## SOUL.md
${soul.trim() || "(empty)"}

## MEMORY.md
${memory.trim() || "(empty)"}`;
}



function buildPrompt(payload: WorkerPayload, hasImages: boolean, hasFiles: boolean): string {
	const sender = [payload.job.event.sender.displayName, payload.job.event.sender.externalId].filter(Boolean).join(" / ");
	const lines = [
		payload.job.event.eventType ? `Event: ${payload.job.event.eventType}` : undefined,
		payload.scheduledReminder
			? `Scheduled reminder due: ${payload.scheduledReminder.scheduledFor} (${payload.scheduledReminder.timezone})`
			: undefined,
		payload.scheduledReminder
			? `Reminder request: ${payload.scheduledReminder.message}`
			: undefined,
		sender ? `Sender: ${sender}` : undefined,
		payload.job.event.replyToMessageId ? `Replying to message: ${payload.job.event.replyToMessageId}` : undefined,
		"Content:",
		...summarizeBlocks(payload.job.event.blocks),
	];
	if (hasImages) {
		lines.push(
			"\n[Image data attached. Analyze directly using vision — do not try to read image files with coding tools.]",
		);
	}
	if (hasFiles) {
		lines.push("\n[FILES AVAILABLE IN WORKSPACE: Any File paths listed above are already saved under the workspace. Read those files directly if you need their contents.]");
	}
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

function augmentModelInputFromRuntimeConfig(
	model: Model<Api>,
	runtimeModelsPath: string,
): Model<Api> {
	if (model.input.includes("image")) {
		return model;
	}
	if (!existsSync(runtimeModelsPath)) {
		return model;
	}
	try {
		const config = JSON.parse(readFileSync(runtimeModelsPath, "utf-8")) as RuntimeModelsConfig;
		const input = resolveRuntimeModelInput(config, model.provider, model.id);
		if (!input?.includes("image")) {
			return model;
		}
		return {
			...model,
			input: Array.from(new Set([...model.input, ...input])),
		} as Model<Api>;
	} catch {
		return model;
	}
}

export async function runWorker(payload: WorkerPayload): Promise<WorkerResult> {
	const runtimeAgentDir = join(WORKSPACE_DIR, ".nekoclaw-runtime");
	const settingsManager = SettingsManager.inMemory({
		compaction: SESSION_COMPACTION_SETTINGS,
	});
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
		runtimeDirectory: payload.runtimeDirectory,
		serverTimezone: payload.serverTimezone,
		sessionCrons: payload.sessionCrons,
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
		model = augmentModelInputFromRuntimeConfig(model, join(runtimeAgentDir, "models.json"));
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

	// Get images from current message or recent history
	const recentMessages = (session.state.messages || []) as (UserMessage | AssistantMessage)[];
	const images = collectPromptImages(payload, WORKSPACE_DIR, recentMessages);
	const hasFiles = payload.job.event.blocks.some((block) => block.kind === "file" && block.attachment?.relativePath);
	const shapedMessages = shapeSessionMessagesForPrompt((session.state.messages || []) as Message[]);
	(session.state as { messages: Message[] }).messages = shapedMessages;

	let finalUserPrompt = buildPrompt(payload, images.length > 0, hasFiles);
	if (payload.scheduledReminder) {
		finalUserPrompt =
			`[SYSTEM HINT: This is a scheduled reminder firing for the current paired session. The reminder request was previously configured as: ${payload.scheduledReminder.message}. You are not responding to a fresh user message; you are proactively delivering the reminder in this same session.]\n\n${finalUserPrompt}`;
	}
	if (images.length > 0) {
		finalUserPrompt +=
			"\n\n[SYSTEM HINT: Image pixel data is loaded into your vision channel. Analyze directly — do not read image files with coding tools.]";
	}
	if (hasFiles) {
		finalUserPrompt +=
			"\n\n[SYSTEM HINT: For attached text or document files, use the relative File path shown above and inspect that file from the workspace when needed.]";
	}

	await session.prompt(finalUserPrompt, images.length > 0 ? { images } : undefined);

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
