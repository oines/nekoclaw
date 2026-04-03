export interface PersonaMemoryManifestEntry {
	path: string;
	kind: "people" | "scene";
	title: string;
	description: string;
	mtimeMs: number;
}

export interface ParsedPersonaMemoryFile {
	path: string;
	kind: "people" | "scene";
	title: string;
	description: string;
	bodyContent: string;
	hasFrontmatter: boolean;
}

export interface FormationRetryState {
	signature: string;
	attempts: number;
	updatedAt: string;
	lastError?: string;
}

export interface DreamState {
	lastCompletedAt?: string;
	lastAttemptedAt?: string;
	lastCorpusSignature?: string;
	lastError?: string;
}

export interface DreamObservationEntry {
	path: string;
	lineCount: number;
	mtimeMs: number;
}

export interface DreamCorpusSnapshot {
	indexPresent: boolean;
	indexMtimeMs: number;
	indexSizeBytes: number;
	manifest: PersonaMemoryManifestEntry[];
	observations: DreamObservationEntry[];
	memoryManifestText: string;
	corpusSignature: string;
}

export interface MaintenanceFinalizeDetails {
	consumeObservationLines?: number;
	summary?: string;
}

export interface MaintenanceExecutionResult {
	finalize: MaintenanceFinalizeDetails;
	touchedPaths: string[];
	deletedPaths: string[];
}

export interface PersonaMemoryRuntimeState {
	maintenanceLocks: Map<string, Promise<void>>;
	backlogSweepQueued: Set<string>;
	dreamQueued: Set<string>;
	dreamSkipAuditCache: Map<string, string>;
}
