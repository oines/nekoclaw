export class QueueFullError extends Error {
	readonly code = "QUEUE_FULL";

	constructor(message = "Queue is full") {
		super(message);
		this.name = "QueueFullError";
	}
}

export class RuntimeBusyError extends Error {
	readonly code = "RUNTIME_BUSY";

	constructor(message = "Runtime is busy") {
		super(message);
		this.name = "RuntimeBusyError";
	}
}

export class SessionStoppedError extends Error {
	readonly code = "SESSION_STOPPED";
	readonly agentId: string;
	readonly sessionRecordId: string;
	readonly jobId?: string;

	constructor(params: { agentId: string; sessionRecordId: string; jobId?: string; message?: string }) {
		super(params.message ?? "Session was stopped");
		this.name = "SessionStoppedError";
		this.agentId = params.agentId;
		this.sessionRecordId = params.sessionRecordId;
		this.jobId = params.jobId;
	}
}

export function isSessionStoppedError(error: unknown): error is SessionStoppedError {
	if (error instanceof SessionStoppedError) {
		return true;
	}
	if (typeof error !== "object" || error === null) {
		return false;
	}
	const code = "code" in error ? String((error as { code?: unknown }).code) : undefined;
	const name = "name" in error ? String((error as { name?: unknown }).name) : undefined;
	return code === "SESSION_STOPPED" || name === "SessionStoppedError";
}

export function isRuntimeBackpressureError(error: unknown): error is QueueFullError | RuntimeBusyError {
	if (error instanceof QueueFullError || error instanceof RuntimeBusyError) {
		return true;
	}
	if (typeof error !== "object" || error === null) {
		return false;
	}
	const code = "code" in error ? String((error as { code?: unknown }).code) : undefined;
	const name = "name" in error ? String((error as { name?: unknown }).name) : undefined;
	return code === "QUEUE_FULL" || code === "RUNTIME_BUSY" || name === "QueueFullError" || name === "RuntimeBusyError";
}
