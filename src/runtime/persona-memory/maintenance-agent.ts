import { rmSync, mkdirSync, existsSync, cpSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import {
	AuthStorage,
	createAgentSession,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readTextFile, writeTextFile } from "../../store/fs.js";
import { MAINTENANCE_TIMEOUT_MS } from "./constants.js";
import { ensureCanonicalPersonaMemoryContent } from "./parser.js";
import { PersonaPaths } from "./paths.js";
import type { MaintenanceExecutionResult, MaintenanceFinalizeDetails } from "./types.js";
import type { AgentSpec, WorkerPayload } from "../../types.js";

const PersonaFinalizeSchema = Type.Object({
	consumeObservationLines: Type.Optional(Type.Number({ description: "Number of observation lines (counting from the top of the log) that have been processed into memory files and can be safely discarded." })),
	summary: Type.Optional(Type.String({ description: "Short summary of what was changed in this maintenance run." })),
});

const DeleteMemoryFileSchema = Type.Object({
	path: Type.String({ description: "Relative path under memory/people or memory/scenes to delete." }),
});

function isAllowedMemoryPath(value: string): boolean {
	return !value.includes("..") && (value.startsWith("memory/people/") || value.startsWith("memory/scenes/")) && value.endsWith(".md");
}

function isIndexPath(value: string): boolean {
	return value === "index.md";
}

function isObservationPath(value: string): boolean {
	return !value.includes("..") && value.startsWith("observations/") && value.endsWith(".log");
}

function normalizeText(value: string | undefined): string {
	return value?.trim() || "";
}

function safeJoinPersonaPath(personaDir: string, relativePath: string): string {
	return join(personaDir, relativePath);
}

function normalizeRelativeMaintenancePath(baseDir: string, inputPath: string): string {
	const absolutePath = resolve(baseDir, inputPath);
	const relativePath = relative(baseDir, absolutePath).replace(/\\/g, "/");
	if (relativePath === "" || relativePath.startsWith("../") || relativePath === "..") {
		throw new Error(`Path "${inputPath}" is outside the persona workspace.`);
	}
	return relativePath;
}

function assertReadableMaintenancePath(relativePath: string): void {
	if (isIndexPath(relativePath) || isAllowedMemoryPath(relativePath) || isObservationPath(relativePath)) {
		return;
	}
	throw new Error(`Read is only allowed for index.md, memory/**, and observations/**. Received "${relativePath}".`);
}

function assertEditableMaintenancePath(relativePath: string): void {
	if (isIndexPath(relativePath) || isAllowedMemoryPath(relativePath)) {
		return;
	}
	throw new Error(`Edit is only allowed for index.md and memory/people|scenes markdown files. Received "${relativePath}".`);
}

function assertWritableMaintenancePath(relativePath: string): void {
	if (!isAllowedMemoryPath(relativePath) || isIndexPath(relativePath)) {
		throw new Error(`Write is only allowed for new memory/people or memory/scenes markdown files. Received "${relativePath}".`);
	}
}

function assertDeletableMaintenancePath(relativePath: string): void {
	if (!isAllowedMemoryPath(relativePath)) {
		throw new Error(`Delete is only allowed for memory/people or memory/scenes markdown files. Received "${relativePath}".`);
	}
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	return await new Promise<T>((resolve, reject) => {
		const timeout = setTimeout(() => {
			reject(new Error(message));
		}, timeoutMs);
		timeout.unref?.();
		void promise
			.then((value) => {
				clearTimeout(timeout);
				resolve(value);
			})
			.catch((error) => {
				clearTimeout(timeout);
				reject(error);
			});
	});
}

export function createMaintenanceClone(paths: PersonaPaths): { tempRoot: string; tempPersonaDir: string; livePersonaDir: string } {
	const tempRoot = mkdtempSync(join(tmpdir(), "nekoclaw-persona-maint-"));
	const tempPersonaDir = join(tempRoot, ".nekoclaw-persona");
	const livePersonaDir = paths.personaDir;
	cpSync(livePersonaDir, tempPersonaDir, { recursive: true, force: true });
	return { tempRoot, tempPersonaDir, livePersonaDir };
}

export function destroyMaintenanceClone(tempRoot: string): void {
	rmSync(tempRoot, { recursive: true, force: true });
}

export function syncMaintenanceClone(
	livePersonaDir: string,
	tempPersonaDir: string,
	result: MaintenanceExecutionResult,
	options: { allowDeletes: boolean },
): void {
	const uniqueTouched = Array.from(new Set(result.touchedPaths));
	for (const relativePath of uniqueTouched) {
		if (!isIndexPath(relativePath) && !isAllowedMemoryPath(relativePath)) {
			continue;
		}
		const tempPath = safeJoinPersonaPath(tempPersonaDir, relativePath);
		if (!existsSync(tempPath)) {
			continue;
		}
		const rawContent = readTextFile(tempPath, "");
		const nextContent = isAllowedMemoryPath(relativePath) ? ensureCanonicalPersonaMemoryContent(relativePath, rawContent) : rawContent;
		writeTextFile(safeJoinPersonaPath(livePersonaDir, relativePath), nextContent);
	}
	if (!options.allowDeletes) {
		return;
	}
	for (const relativePath of Array.from(new Set(result.deletedPaths))) {
		if (!isAllowedMemoryPath(relativePath)) {
			continue;
		}
		rmSync(safeJoinPersonaPath(livePersonaDir, relativePath), { force: true });
	}
}

export async function executeMaintenanceSession(input: {
	agent: AgentSpec;
	effectiveModel: WorkerPayload["effectiveModel"] | undefined;
	tempPersonaDir: string;
	mode: "formation" | "dream";
	prompt: string;
	maxConsumeObservationLines: number;
	allowDeletes: boolean;
	resolveModel: (
		agent: AgentSpec,
		effectiveModel: WorkerPayload["effectiveModel"] | undefined,
	) =>
		| {
				model: NonNullable<ReturnType<ModelRegistry["find"]>>;
				apiKey?: string;
		  }
		| undefined;
}): Promise<MaintenanceExecutionResult> {
	const modelConfig = input.resolveModel(input.agent, input.effectiveModel);
	if (!modelConfig) {
		throw new Error("No configured model available for persona maintenance.");
	}
	const authStorage = AuthStorage.inMemory();
	if (modelConfig.apiKey) {
		authStorage.setRuntimeApiKey(modelConfig.model.provider, modelConfig.apiKey);
	}
	const runtimeAgentDir = join(input.tempPersonaDir, ".maintenance-runtime");
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
	});
	const modelRegistry = new ModelRegistry(authStorage, join(runtimeAgentDir, "models.json"));
	const resourceLoader = new DefaultResourceLoader({
		cwd: input.tempPersonaDir,
		agentDir: runtimeAgentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		systemPrompt: [
			input.mode === "dream"
				? "You are Nekoclaw Dream, a global persona memory maintainer."
				: "You are Nekoclaw formation, a scene-local persona memory maintainer.",
			"You are working inside a temporary clone of .nekoclaw-persona.",
			"Use read/edit/write tools to maintain index.md and memory markdown files directly.",
			"People and scene memory files must use YAML frontmatter with title and description, followed by natural-language Markdown body text.",
			"Existing files must be revised with edit. Use write only to create a new memory/people or memory/scenes file that does not exist yet.",
			"Preserve existing frontmatter when it is still correct, revise description when the body meaning changes, and add frontmatter when editing a legacy file without it.",
			input.mode === "dream"
				? "Dream may delete low-value memory/people or memory/scenes files when forgetting is appropriate, but it must preserve corrections, confirmed identity links, core relationships, and long-term background."
				: "Formation must not delete any files.",
			"Never modify observations/ or control/. Observations are evidence only.",
			"Do not invent facts. Preserve uncertainty and preserve whether you only observed something or participated in it.",
			"Before you finish, you must call persona_finalize exactly once.",
			"Call persona_finalize only after every edit is complete.",
			"If no files need to change, still call persona_finalize exactly once.",
			"After calling persona_finalize, stop immediately and do not use any more tools.",
		].join("\n"),
		agentsFilesOverride: () => ({ agentsFiles: [] }),
	});
	await resourceLoader.reload();

	const touchedPaths = new Set<string>();
	const deletedPaths = new Set<string>();
	let finalizeCount = 0;
	let finalize: MaintenanceFinalizeDetails | undefined;

	const readTool = createReadToolDefinition(input.tempPersonaDir, {
		operations: {
			access: async (absolutePath) => {
				const relativePath = normalizeRelativeMaintenancePath(input.tempPersonaDir, absolutePath);
				assertReadableMaintenancePath(relativePath);
			},
			readFile: async (absolutePath) => {
				const relativePath = normalizeRelativeMaintenancePath(input.tempPersonaDir, absolutePath);
				assertReadableMaintenancePath(relativePath);
				return await import("node:fs/promises").then((fs) => fs.readFile(absolutePath));
			},
		},
	});
	const editTool = createEditToolDefinition(input.tempPersonaDir, {
		operations: {
			access: async (absolutePath) => {
				const relativePath = normalizeRelativeMaintenancePath(input.tempPersonaDir, absolutePath);
				assertEditableMaintenancePath(relativePath);
				if (!existsSync(absolutePath)) {
					throw new Error(`Edit target "${relativePath}" does not exist.`);
				}
			},
			readFile: async (absolutePath) => {
				const relativePath = normalizeRelativeMaintenancePath(input.tempPersonaDir, absolutePath);
				assertEditableMaintenancePath(relativePath);
				return await import("node:fs/promises").then((fs) => fs.readFile(absolutePath));
			},
			writeFile: async (absolutePath, content) => {
				const relativePath = normalizeRelativeMaintenancePath(input.tempPersonaDir, absolutePath);
				assertEditableMaintenancePath(relativePath);
				touchedPaths.add(relativePath);
				await import("node:fs/promises").then((fs) => fs.writeFile(absolutePath, content, "utf-8"));
			},
		},
	});
	const writeTool = createWriteToolDefinition(input.tempPersonaDir, {
		operations: {
			mkdir: async (dir) => {
				const relativePath = normalizeRelativeMaintenancePath(input.tempPersonaDir, dir);
				if (
					relativePath !== "memory/people" &&
					relativePath !== "memory/scenes" &&
					!relativePath.startsWith("memory/people/") &&
					!relativePath.startsWith("memory/scenes/")
				) {
					throw new Error(`Write can only create files under memory/people or memory/scenes. Received directory "${relativePath}".`);
				}
				await import("node:fs/promises").then((fs) => fs.mkdir(dir, { recursive: true }));
			},
			writeFile: async (absolutePath, content) => {
				const relativePath = normalizeRelativeMaintenancePath(input.tempPersonaDir, absolutePath);
				assertWritableMaintenancePath(relativePath);
				if (existsSync(absolutePath)) {
					throw new Error(`Write may only create new files. "${relativePath}" already exists; use edit instead.`);
				}
				touchedPaths.add(relativePath);
				await import("node:fs/promises").then((fs) => fs.writeFile(absolutePath, content, "utf-8"));
			},
		},
	});

	const customTools: Array<ToolDefinition<any, any, any>> = [
		readTool,
		editTool,
		writeTool,
		{
			name: "persona_finalize",
			label: "Finalize Persona Maintenance",
			description: "Finalize this maintenance run exactly once after all file edits are complete.",
			parameters: PersonaFinalizeSchema,
			execute: async (_toolCallId, params: { consumeObservationLines?: number; summary?: string }) => {
				finalizeCount += 1;
				if (finalizeCount > 1) {
					throw new Error("persona_finalize may only be called once.");
				}
				finalize = {
					consumeObservationLines:
						input.mode === "dream"
							? 0
							: Math.max(0, Math.min(input.maxConsumeObservationLines, Math.floor(Number(params.consumeObservationLines ?? 0) || 0))),
					summary: normalizeText(params.summary),
				};
				return {
					content: [{ type: "text", text: "Persona maintenance finalized." }],
					details: {},
				};
			},
		},
	];

	if (input.allowDeletes) {
		customTools.push({
			name: "delete_memory_file",
			label: "Delete Memory File",
			description: "Delete an existing memory/people or memory/scenes markdown file when Dream decides it should be forgotten.",
			parameters: DeleteMemoryFileSchema,
			execute: async (_toolCallId, params: { path: string }) => {
				const relativePath = normalizeRelativeMaintenancePath(input.tempPersonaDir, params.path);
				assertDeletableMaintenancePath(relativePath);
				const absolutePath = safeJoinPersonaPath(input.tempPersonaDir, relativePath);
				if (!existsSync(absolutePath)) {
					throw new Error(`Cannot delete "${relativePath}" because it does not exist.`);
				}
				deletedPaths.add(relativePath);
				rmSync(absolutePath, { force: true });
				return {
					content: [{ type: "text", text: `Deleted ${relativePath}.` }],
					details: {},
				};
			},
		});
	}

	const { session } = await createAgentSession({
		cwd: input.tempPersonaDir,
		agentDir: runtimeAgentDir,
		authStorage,
		modelRegistry,
		settingsManager,
		sessionManager: SessionManager.inMemory(),
		resourceLoader,
		model: modelConfig.model,
		thinkingLevel: input.effectiveModel?.thinkingLevel ?? input.agent.thinkingLevel,
		tools: [],
		customTools,
	});
	await withTimeout(session.prompt(input.prompt), MAINTENANCE_TIMEOUT_MS, `Persona maintenance timed out after ${MAINTENANCE_TIMEOUT_MS}ms.`);
	if (finalizeCount !== 1 || !finalize) {
		throw new Error(`persona_finalize must be called exactly once; saw ${finalizeCount}.`);
	}
	return {
		finalize,
		touchedPaths: Array.from(touchedPaths),
		deletedPaths: Array.from(deletedPaths),
	};
}
