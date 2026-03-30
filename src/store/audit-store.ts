import type { AuditEntry } from "../types.js";
import { appendJsonLine, readJsonLines } from "./fs.js";
import { nowIso } from "./helpers.js";
import { StorePaths } from "./paths.js";

export class AuditStore {
	constructor(private readonly paths: StorePaths) {}

	audit(agentId: string, kind: string, details: Record<string, unknown>): AuditEntry {
		const entry: AuditEntry = {
			timestamp: nowIso(),
			kind,
			agentId,
			details,
		};
		appendJsonLine(this.paths.getAuditPath(agentId), entry);
		return entry;
	}

	getAuditEntries(agentId: string): AuditEntry[] {
		return readJsonLines<AuditEntry>(this.paths.getAuditPath(agentId));
	}
}
