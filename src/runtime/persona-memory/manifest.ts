import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { readTextFile } from "../../store/fs.js";
import { MANIFEST_SCAN_MAX_FILES } from "./constants.js";
import { parsePersonaMemoryFile, readFileHeaderWindow } from "./parser.js";
import { PersonaPaths } from "./paths.js";
import type { DreamCorpusSnapshot, DreamObservationEntry, PersonaMemoryManifestEntry } from "./types.js";

function listMarkdownFiles(dir: string, baseDir: string): string[] {
	if (!existsSync(dir)) {
		return [];
	}
	const entries = readdirSync(dir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const absolute = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...listMarkdownFiles(absolute, baseDir));
			continue;
		}
		if (entry.isFile() && entry.name.endsWith(".md")) {
			files.push(relative(baseDir, absolute).replace(/\\/g, "/"));
		}
	}
	return files.sort();
}

function listFilesWithExtension(dir: string, baseDir: string, extension: string): string[] {
	if (!existsSync(dir)) {
		return [];
	}
	return readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(extension))
		.map((entry) => relative(baseDir, join(dir, entry.name)).replace(/\\/g, "/"))
		.sort();
}

function safeJoinPersonaPath(personaDir: string, relativePath: string): string {
	return join(personaDir, relativePath);
}

export function formatPersonaMemoryManifest(entries: PersonaMemoryManifestEntry[]): string {
	if (entries.length === 0) {
		return "(none)";
	}
	return entries
		.map(
			(entry) =>
				`- [${entry.kind}] ${entry.title || "(untitled)"} | ${entry.path} (${new Date(entry.mtimeMs).toISOString()}): ${entry.description || "(no description)"}`,
		)
		.join("\n");
}

export function scanPersonaMemoryManifest(paths: PersonaPaths): PersonaMemoryManifestEntry[] {
	const personaDir = paths.personaDir;
	const relativePaths = [...listMarkdownFiles(paths.peopleDir, personaDir), ...listMarkdownFiles(paths.scenesDir, personaDir)];
	return relativePaths
		.map((relativePath) => {
			const absolutePath = safeJoinPersonaPath(personaDir, relativePath);
			const parsed = parsePersonaMemoryFile(relativePath, readFileHeaderWindow(absolutePath));
			const stats = statSync(absolutePath);
			return {
				path: parsed.path,
				kind: parsed.kind,
				title: parsed.title,
				description: parsed.description,
				mtimeMs: stats.mtimeMs,
			} satisfies PersonaMemoryManifestEntry;
		})
		.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path))
		.slice(0, MANIFEST_SCAN_MAX_FILES);
}

export function readDreamObservationEntry(personaDir: string, relativePath: string): DreamObservationEntry {
	const absolutePath = safeJoinPersonaPath(personaDir, relativePath);
	const content = readTextFile(absolutePath, "");
	const stats = statSync(absolutePath);
	const lines = content
		.split(/\r?\n/)
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0);
	return {
		path: relativePath,
		lineCount: lines.length,
		mtimeMs: stats.mtimeMs,
	};
}

export function buildDreamCorpusSnapshot(paths: PersonaPaths): DreamCorpusSnapshot {
	const manifest = scanPersonaMemoryManifest(paths);
	const observations = listFilesWithExtension(paths.observationsDir, paths.personaDir, ".log").map((path) =>
		readDreamObservationEntry(paths.personaDir, path),
	);
	const indexPresent = existsSync(paths.indexPath);
	const indexStats = indexPresent ? statSync(paths.indexPath) : undefined;
	const signatureSeed = [
		`index:index.md:${indexStats?.mtimeMs ?? 0}`,
		...manifest.map((entry) => `memory:${entry.path}:${entry.mtimeMs}`),
		...observations.map((entry) => `observation:${entry.path}:${entry.mtimeMs}:${entry.lineCount}`),
	].join("\n\n");
	return {
		indexPresent,
		indexMtimeMs: indexStats?.mtimeMs ?? 0,
		indexSizeBytes: indexStats?.size ?? 0,
		manifest,
		observations,
		memoryManifestText: formatPersonaMemoryManifest(manifest),
		corpusSignature: createHash("sha256").update(signatureSeed).digest("hex"),
	};
}
