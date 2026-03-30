#!/usr/bin/env node

process.title = "nekoclaw";
const _originalEmitWarning = process.emitWarning;
process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
	const type = typeof args[0] === "string" ? args[0] : (args[0] as { type?: string } | undefined)?.type;
	if (type === "ExperimentalWarning") return;
	return (_originalEmitWarning as Function).call(process, warning, ...args);
}) as typeof process.emitWarning;

import { main } from "./main.js";

void main(process.argv.slice(2));
