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
