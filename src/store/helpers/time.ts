export function nowIso(): string {
	return new Date().toISOString();
}

export function sixDigitCode(): string {
	return `${Math.floor(100000 + Math.random() * 900000)}`;
}
