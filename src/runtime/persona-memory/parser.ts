import { openSync, readSync, closeSync } from "node:fs";
import { MANIFEST_SCAN_MAX_BYTES, MANIFEST_TEXT_MAX_CHARS } from "./constants.js";
import type { ParsedPersonaMemoryFile } from "./types.js";

export function trimManifestText(value: string, maxChars = MANIFEST_TEXT_MAX_CHARS): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxChars) {
		return normalized;
	}
	return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export function extractFrontmatterBlock(content: string): { frontmatter: Record<string, string>; body: string; hasFrontmatter: boolean } {
	const normalized = content.replace(/\r\n/g, "\n");
	if (!normalized.startsWith("---\n")) {
		return { frontmatter: {}, body: content, hasFrontmatter: false };
	}
	const lines = normalized.split("\n");
	let closingIndex = -1;
	for (let index = 1; index < lines.length; index += 1) {
		if (lines[index]?.trim() === "---") {
			closingIndex = index;
			break;
		}
	}
	if (closingIndex < 1) {
		return { frontmatter: {}, body: content, hasFrontmatter: false };
	}
	const frontmatter: Record<string, string> = {};
	for (const rawLine of lines.slice(1, closingIndex)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) {
			continue;
		}
		const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!match?.[1]) {
			continue;
		}
		let value = (match[2] ?? "").trim();
		const quoted = value.match(/^(['"])(.*)\1$/);
		if (quoted?.[2] !== undefined) {
			value = quoted[2];
		}
		frontmatter[match[1]] = value;
	}
	return {
		frontmatter,
		body: lines.slice(closingIndex + 1).join("\n").replace(/^\n+/, ""),
		hasFrontmatter: true,
	};
}

export function deriveLegacyTitle(relativePath: string, body: string): string {
	for (const rawLine of body.split(/\r?\n/)) {
		const line = rawLine.trim();
		const heading = line.match(/^#{1,6}\s+(.+)$/);
		if (heading?.[1]) {
			return trimManifestText(heading[1], 120);
		}
	}
	return relativePath.split("/").pop()?.replace(/\.md$/i, "") ?? relativePath;
}

export function deriveLegacyDescription(body: string): string {
	const lines = body
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.match(/^#{1,6}\s+/));
	if (lines.length === 0) {
		return "";
	}
	const start = lines[0]!.replace(/^[-*]\s+/, "");
	const continuation = lines.slice(1).find((line) => !line.startsWith("- ") && !line.startsWith("* "));
	return trimManifestText([start, continuation].filter(Boolean).join(" "));
}

export function parsePersonaMemoryFile(relativePath: string, rawContent: string): ParsedPersonaMemoryFile {
	const { frontmatter, body, hasFrontmatter } = extractFrontmatterBlock(rawContent);
	const bodyContent = body.trim();
	return {
		path: relativePath,
		kind: relativePath.startsWith("memory/people/") ? "people" : "scene",
		title: trimManifestText(frontmatter.title || deriveLegacyTitle(relativePath, bodyContent), 120),
		description: trimManifestText(frontmatter.description || deriveLegacyDescription(bodyContent)),
		bodyContent,
		hasFrontmatter,
	};
}

function escapeFrontmatterValue(value: string): string {
	return JSON.stringify(value);
}

export function ensureCanonicalPersonaMemoryContent(relativePath: string, rawContent: string): string {
	const entry = parsePersonaMemoryFile(relativePath, rawContent);
	if (entry.hasFrontmatter) {
		return rawContent;
	}
	const body = entry.bodyContent || rawContent.trim();
	return [
		"---",
		`title: ${escapeFrontmatterValue(entry.title)}`,
		`description: ${escapeFrontmatterValue(entry.description)}`,
		"---",
		"",
		body,
	].join("\n").trimEnd() + "\n";
}

export function readFileHeaderWindow(path: string, maxBytes = MANIFEST_SCAN_MAX_BYTES): string {
	const fd = openSync(path, "r");
	try {
		const buffer = Buffer.allocUnsafe(maxBytes);
		const bytesRead = readSync(fd, buffer, 0, maxBytes, 0);
		return buffer.subarray(0, bytesRead).toString("utf-8");
	} finally {
		closeSync(fd);
	}
}
