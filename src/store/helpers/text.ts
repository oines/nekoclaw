export function normalizeTextForWrite(value: string): string {
	return value.endsWith("\n") ? value : `${value}\n`;
}
