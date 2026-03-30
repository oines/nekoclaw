import { runNekoclawCommand } from "./cli/commands.js";

export async function main(args: string[]): Promise<void> {
	await runNekoclawCommand(args);
}
