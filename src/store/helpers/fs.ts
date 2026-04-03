import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { readJsonFile } from "../fs.js";

export function ensureDir(path: string): void {
	if (!existsSync(path)) {
		mkdirSync(path, { recursive: true });
	}
}

export function readDirectoryJson<T>(dir: string): T[] {
	if (!existsSync(dir)) {
		return [];
	}
	return readdirSync(dir)
		.filter((entry) => entry.endsWith(".json"))
		.map((entry) => readJsonFile<T>(`${dir}/${entry}`, {} as T))
		.filter((value) => Object.keys(value as object).length > 0);
}
