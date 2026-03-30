import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { ensureParentDir, writeBinaryFile } from "./store/fs.js";
import type { AttachmentRef } from "./types.js";

const MIME_EXTENSION_MAP: Record<string, string> = {
	"application/pdf": ".pdf",
	"image/gif": ".gif",
	"image/jpeg": ".jpg",
	"image/png": ".png",
	"image/webp": ".webp",
	"text/plain": ".txt",
};

export function sanitizeFileName(name: string): string {
	return name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function resolveFileExtension(input: {
	name?: string;
	mimeType?: string;
	kind: AttachmentRef["kind"];
}): string {
	if (input.name) {
		const extension = extname(input.name);
		if (extension) {
			return extension;
		}
	}
	if (input.mimeType && MIME_EXTENSION_MAP[input.mimeType]) {
		return MIME_EXTENSION_MAP[input.mimeType];
	}
	return input.kind === "image" ? ".jpg" : ".bin";
}

function buildAttachmentFileName(input: {
	fallbackBaseName: string;
	name?: string;
	mimeType?: string;
	kind: AttachmentRef["kind"];
}): string {
	const extension = resolveFileExtension(input);
	const originalName = input.name ? sanitizeFileName(input.name) : "";
	if (originalName) {
		return extname(originalName) ? originalName : `${originalName}${extension}`;
	}
	return `${sanitizeFileName(input.fallbackBaseName)}${extension}`;
}

function createUniqueFileName(attachmentsDir: string, preferredName: string): string {
	const extension = extname(preferredName);
	const baseName = extension ? preferredName.slice(0, -extension.length) : preferredName;
	let candidate = preferredName;
	let index = 1;
	while (existsSync(join(attachmentsDir, candidate))) {
		candidate = `${baseName}-${index}${extension}`;
		index += 1;
	}
	return candidate;
}

export function persistAttachment(input: {
	attachmentsDir: string;
	attachmentsRelativeDir: string;
	bytes: Uint8Array;
	kind: AttachmentRef["kind"];
	fallbackBaseName: string;
	name?: string;
	mimeType?: string;
	sizeBytes?: number;
}): AttachmentRef {
	const preferredName = buildAttachmentFileName(input);
	const fileName = createUniqueFileName(input.attachmentsDir, preferredName);
	const absolutePath = join(input.attachmentsDir, fileName);
	ensureParentDir(absolutePath);
	writeBinaryFile(absolutePath, input.bytes);
	return {
		kind: input.kind,
		name: input.name ?? fileName,
		relativePath: `${input.attachmentsRelativeDir}/${fileName}`,
		mimeType: input.mimeType,
		sizeBytes: input.sizeBytes ?? input.bytes.byteLength,
	};
}

export async function downloadBinary(url: string): Promise<Uint8Array> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Failed to download media from ${url}`);
	}
	return new Uint8Array(await response.arrayBuffer());
}

export function readLocalBinary(path: string): Uint8Array {
	return new Uint8Array(readFileSync(path));
}

