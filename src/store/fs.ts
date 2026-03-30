import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";

export function ensureParentDir(path: string): void {
	const dir = dirname(path);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}

function ensureLockFile(path: string): void {
	ensureParentDir(path);
	if (!existsSync(path)) {
		writeFileSync(path, "", "utf-8");
	}
}

function acquireLockSyncWithRetry(path: string): () => void {
	const maxAttempts = 10;
	const delayMs = 20;
	let lastError: unknown;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return lockfile.lockSync(path, { realpath: false });
		} catch (error) {
			const code =
				typeof error === "object" && error !== null && "code" in error
					? String((error as { code?: unknown }).code)
					: undefined;
			if (code !== "ELOCKED" || attempt === maxAttempts) {
				throw error;
			}
			lastError = error;
			const start = Date.now();
			while (Date.now() - start < delayMs) {
				// Busy wait to keep the helper synchronous.
			}
		}
	}

	throw (lastError as Error) ?? new Error("Failed to acquire nekoclaw file lock");
}

export function withFileLock<T>(path: string, fn: () => T): T {
	ensureLockFile(path);
	const release = acquireLockSyncWithRetry(path);
	try {
		return fn();
	} finally {
		release();
	}
}

export function readJsonFile<T>(path: string, fallback: T): T {
	if (!existsSync(path)) {
		return fallback;
	}
	const raw = readFileSync(path, "utf-8").trim();
	if (!raw) {
		return fallback;
	}
	return JSON.parse(raw) as T;
}

interface WriteFileOptions {
	mode?: number;
	skipLock?: boolean;
}

function writeAtomic(path: string, value: string, options: WriteFileOptions = {}): void {
	ensureParentDir(path);
	const tempPath = `${path}.tmp`;
	writeFileSync(tempPath, value, {
		encoding: "utf-8",
		mode: options.mode,
	});
	renameSync(tempPath, path);
	if (options.mode !== undefined) {
		chmodSync(path, options.mode);
	}
}

export function writeJsonFile(path: string, value: unknown, options: WriteFileOptions = {}): void {
	const write = () => writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`, options);
	if (options.skipLock) {
		write();
		return;
	}
	withFileLock(path, write);
}

export function writeTextFile(path: string, value: string, options: WriteFileOptions = {}): void {
	const write = () => writeAtomic(path, value, options);
	if (options.skipLock) {
		write();
		return;
	}
	withFileLock(path, write);
}

export function writeBinaryFile(path: string, value: Uint8Array, options: WriteFileOptions = {}): void {
	const write = () => {
		ensureParentDir(path);
		const tempPath = `${path}.tmp`;
		writeFileSync(tempPath, value, {
			mode: options.mode,
		});
		renameSync(tempPath, path);
		if (options.mode !== undefined) {
			chmodSync(path, options.mode);
		}
	};
	if (options.skipLock) {
		write();
		return;
	}
	withFileLock(path, write);
}

export function readTextFile(path: string, fallback = ""): string {
	if (!existsSync(path)) return fallback;
	return readFileSync(path, "utf-8");
}

export function appendJsonLine(path: string, value: unknown): void {
	withFileLock(path, () => {
		ensureParentDir(path);
		appendFileSync(path, `${JSON.stringify(value)}\n`, "utf-8");
	});
}

export function readJsonLines<T>(path: string): T[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf-8")
		.split(/\r?\n/)
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as T);
}

export function removeFileIfExists(path: string): void {
	if (!existsSync(path)) {
		return;
	}
	unlinkSync(path);
}
