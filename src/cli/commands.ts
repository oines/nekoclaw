import chalk from "chalk";
import { Command, CommanderError } from "commander";
import { NEKOCLAW_NAME } from "../config.js";
import { NekoclawDaemon } from "../runtime/daemon.js";
import { JsonNekoclawStore } from "../store/json-store.js";
import {
	AGENT_CREATE_HELP,
	AGENT_DISABLE_HELP,
	AGENT_ENABLE_HELP,
	AGENT_HELP,
	AGENT_REMOVE_HELP,
	ADMIN_HELP,
	CHANNEL_HELP,
	CHANNEL_TOKEN_HELP,
	DOCTOR_HELP,
	MODEL_HELP,
	MODEL_SET_HELP,
	PAIR_ACCEPT_HELP,
	PAIR_HELP,
	QUICKSTART_HELP,
	RESTART_HELP,
	SESSION_HELP,
	SESSION_REMOVE_HELP,
	START_HELP,
	STATUS_HELP,
	STOP_HELP,
	TOP_LEVEL_HELP,
} from "./help.js";
import {
	handleAgentCreate,
	handleAgentDisable,
	handleAgentEnable,
	handleAgentList,
	handleAgentRemove,
	handleAgentStatus,
	handleAdminAdd,
	handleAdminList,
	handleAdminRemove,
	handleChannelAdd,
	handleChannelEndpoint,
	handleChannelList,
	handleChannelRemove,
	handleChannelToken,
	handleChannelTrigger,
	handleDoctor,
	handleModelCurrent,
	handleModelList,
	handleModelSet,
	handlePairAccept,
	handlePairList,
	handlePairReject,
	handleQuickstart,
	handleRuntimeStart,
	handleRuntimeStop,
	handleRuntimeRestart,
	handleSessionList,
	handleSessionRemove,
	handleStatus,
	runInternalRuntime,
	runInternalWorker,
	type AgentCreateOptions,
	type ChannelTokenOptions,
	type ChannelEndpointOptions,
	type ChannelTriggerOptions,
	type ForceOptions,
	type ModelSetOptions,
	type PairCodeOptions,
	type PairListOptions,
	type PurgeOptions,
	type QuickstartOptions,
} from "./handlers/index.js";

function configureCommandOutput(command: Command): void {
	command
		.showHelpAfterError()
		.showSuggestionAfterError()
		.configureOutput({
			outputError: (message, write) => write(chalk.red(message)),
		})
		.helpOption("-h, --help", "Show help");
}

function commandExamples(command: Command, text: string): Command {
	return command.addHelpText("after", text);
}

function createAgentCommand(store: JsonNekoclawStore, daemon: NekoclawDaemon): Command {
	const agent = new Command("agent").description("Create, inspect, enable, disable, and remove agents.");
	configureCommandOutput(agent);
	commandExamples(agent, AGENT_HELP);

	const create = agent.command("create <name>");
	configureCommandOutput(create);
	commandExamples(
		create
			.description("Create a new agent workspace.")
			.action(async (name: string, options: AgentCreateOptions) => {
				await handleAgentCreate(name, options, store);
			}),
		AGENT_CREATE_HELP,
	);

	const list = agent.command("list");
	configureCommandOutput(list);
	list
		.description("List all agents and their current state.")
		.action(async () => {
			await handleAgentList(store);
		});

	const status = agent.command("status <agent>");
	configureCommandOutput(status);
	status
		.description("Show the current state of one agent.")
		.action(async (agentRef: string) => {
			await handleAgentStatus(agentRef, store);
		});

	const enable = agent.command("enable <agent>");
	configureCommandOutput(enable);
	commandExamples(
		enable
			.description("Bring an agent online so it can process chats.")
			.action(async (agentRef: string) => {
				await handleAgentEnable(agentRef, store, daemon);
			}),
		AGENT_ENABLE_HELP,
	);

	const disable = agent.command("disable <agent>");
	configureCommandOutput(disable);
	commandExamples(
		disable
			.description("Take an agent offline.")
			.action(async (agentRef: string) => {
				await handleAgentDisable(agentRef, store, daemon);
			}),
		AGENT_DISABLE_HELP,
	);

	const remove = agent.command("remove <agent>");
	configureCommandOutput(remove);
	commandExamples(
		remove
			.description("Delete an agent and its configuration.")
			.option("--force", "Remove the agent even if chats or channels still exist")
			.action(async (agentRef: string, options: ForceOptions) => {
				await handleAgentRemove(agentRef, options, store, daemon);
			}),
		AGENT_REMOVE_HELP,
	);

	return agent;
}

function createModelCommand(store: JsonNekoclawStore): Command {
	const model = new Command("model").description("Inspect or change the model an agent uses.");
	configureCommandOutput(model);
	commandExamples(model, MODEL_HELP);

	const current = model.command("current <agent>");
	configureCommandOutput(current);
	current
		.description("Show the current model for an agent.")
		.action(async (agentRef: string) => {
			await handleModelCurrent(agentRef, store);
		});

	const list = model.command("list <agent>");
	configureCommandOutput(list);
	list
		.description("List models available for the agent's current provider.")
		.action(async (agentRef: string) => {
			await handleModelList(agentRef, store);
		});

	const set = model.command("set <agent>");
	configureCommandOutput(set);
	commandExamples(
		set
			.description("Set or switch the model for an agent.")
			.option("--source <source>", "Model source to use: built-in or custom")
			.option("--provider <provider>", "Built-in provider name")
			.option("--model <model>", "Model ID")
			.option("--base-url <baseUrl>", "Custom model base URL")
			.option("--provider-id <providerId>", "Custom model provider ID")
			.option("--api-key <apiKey>", "API key to save in local config")
			.action(async (agentRef: string, options: ModelSetOptions) => {
				await handleModelSet(agentRef, options, store);
			}),
		MODEL_SET_HELP,
	);

	return model;
}

function createAdminCommand(store: JsonNekoclawStore): Command {
	const admin = new Command("admin").description("Manage agent admins bound to platform user ids.");
	configureCommandOutput(admin);
	commandExamples(admin, ADMIN_HELP);

	const add = admin.command("add <agent> <channel> <user-id>");
	configureCommandOutput(add);
	add
		.description("Add a platform-bound admin for an agent.")
		.action(async (agentRef: string, channelType: string, externalUserId: string) => {
			await handleAdminAdd(agentRef, channelType as "telegram" | "napcat", externalUserId, store);
		});

	const list = admin.command("list <agent>");
	configureCommandOutput(list);
	list
		.description("List admins configured for an agent.")
		.action(async (agentRef: string) => {
			await handleAdminList(agentRef, store);
		});

	const remove = admin.command("remove <agent> <channel> <user-id>");
	configureCommandOutput(remove);
	remove
		.description("Remove a platform-bound admin from an agent.")
		.action(async (agentRef: string, channelType: string, externalUserId: string) => {
			await handleAdminRemove(agentRef, channelType as "telegram" | "napcat", externalUserId, store);
		});

	return admin;
}

function createChannelCommand(store: JsonNekoclawStore): Command {
	const channel = new Command("channel").description("Connect an agent to external chat platforms.");
	configureCommandOutput(channel);
	commandExamples(channel, CHANNEL_HELP);

	const add = channel.command("add <agent> [type]");
	configureCommandOutput(add);
	add
		.description("Add a channel to an agent.")
		.action(async (agentRef: string, type?: string) => {
			await handleChannelAdd(agentRef, type as "telegram" | "napcat" | undefined, store);
		});

	const remove = channel.command("remove <agent> [type]");
	configureCommandOutput(remove);
	remove
		.description("Remove a channel from an agent.")
		.option("--force", "Remove the channel even if chats are still paired")
		.action(async (agentRef: string, type: string | undefined, options: ForceOptions) => {
			await handleChannelRemove(agentRef, type as "telegram" | "napcat" | undefined, options, store);
		});

	const list = channel.command("list <agent>");
	configureCommandOutput(list);
	list
		.description("List the channels configured for an agent.")
		.action(async (agentRef: string) => {
			await handleChannelList(agentRef, store);
		});

	const token = channel.command("token <agent> [type]");
	configureCommandOutput(token);
	commandExamples(
		token
			.description("Save or update the token for a channel.")
			.option("--token <token>", "Channel token to save")
			.action(async (agentRef: string, type: string | undefined, options: ChannelTokenOptions) => {
				await handleChannelToken(agentRef, type as "telegram" | "napcat" | undefined, options, store);
			}),
		CHANNEL_TOKEN_HELP,
	);

	const endpoint = channel.command("endpoint <agent> [type]");
	configureCommandOutput(endpoint);
	endpoint
		.description("Save or update the endpoint for a channel.")
		.option("--url <url>", "Channel endpoint URL")
		.option("--self-id <selfId>", "NapCat bot QQ id")
		.action(async (agentRef: string, type: string | undefined, options: ChannelEndpointOptions) => {
			await handleChannelEndpoint(agentRef, type as "telegram" | "napcat" | undefined, options, store);
		});

	const trigger = channel.command("trigger <agent> [type]");
	configureCommandOutput(trigger);
	trigger
		.description("Save or update how group chats trigger this channel.")
		.option("--group <mode>", "Group trigger mode: all or mention")
		.action(async (agentRef: string, type: string | undefined, options: ChannelTriggerOptions) => {
			await handleChannelTrigger(agentRef, type as "telegram" | "napcat" | undefined, options, store);
		});

	return channel;
}

function createPairCommand(store: JsonNekoclawStore): Command {
	const pair = new Command("pair").description("Review and resolve pending pairing requests.");
	configureCommandOutput(pair);
	commandExamples(pair, PAIR_HELP);

	const list = pair.command("list");
	configureCommandOutput(list);
	list
		.description("List current pairing requests.")
		.option("--agent <agent>", "Only show pair requests for one agent")
		.action(async (options: PairListOptions) => {
			await handlePairList(options, store);
		});

	const accept = pair.command("accept");
	configureCommandOutput(accept);
	commandExamples(
		accept
			.description("Accept a pairing request by code.")
			.requiredOption("--code <code>", "Pairing code to accept")
			.action(async (options: PairCodeOptions) => {
				await handlePairAccept(options, store);
			}),
		PAIR_ACCEPT_HELP,
	);

	const reject = pair.command("reject");
	configureCommandOutput(reject);
	reject
		.description("Reject a pairing request by code.")
		.requiredOption("--code <code>", "Pairing code to reject")
		.action(async (options: PairCodeOptions) => {
			await handlePairReject(options, store);
		});

	return pair;
}

function createSessionCommand(store: JsonNekoclawStore): Command {
	const session = new Command("session").description("Inspect or remove sessions paired to an agent.");
	configureCommandOutput(session);
	commandExamples(session, SESSION_HELP);

	const list = session.command("list <agent>");
	configureCommandOutput(list);
	list
		.description("List sessions paired to an agent.")
		.action(async (agentRef: string) => {
			await handleSessionList(agentRef, store);
		});

	const remove = session.command("remove <agent> <session>");
	configureCommandOutput(remove);
	commandExamples(
		remove
			.description("Remove a session from an agent.")
			.option("--purge", "Delete stored session files as well")
			.action(async (agentRef: string, sessionRef: string, options: PurgeOptions) => {
				await handleSessionRemove(agentRef, sessionRef, options, store);
			}),
		SESSION_REMOVE_HELP,
	);

	return session;
}

function createProgram(store: JsonNekoclawStore, daemon: NekoclawDaemon): Command {
	const program = new Command();
	configureCommandOutput(program);
	program
		.name(NEKOCLAW_NAME)
		.description("AI agents for real chats")
		.usage("<command> [options]");
	commandExamples(program, TOP_LEVEL_HELP);

	commandExamples(
		(() => {
			const quickstart = program.command("quickstart");
			configureCommandOutput(quickstart);
			return quickstart;
		})()
			.description("Create an agent, set a model, add Telegram, and save the bot token.")
			.option("--name <name>", "Agent name")
			.option("--source <source>", "Model source to use: built-in or custom")
			.option("--provider <provider>", "Built-in provider name")
			.option("--model <model>", "Model ID")
			.option("--base-url <baseUrl>", "Custom model base URL")
			.option("--provider-id <providerId>", "Custom model provider ID")
			.option("--api-key <apiKey>", "API key to save in local config")
			.option("--token <token>", "Telegram bot token")
			.action(async (options: QuickstartOptions) => {
				await handleQuickstart(store, options);
			}),
		QUICKSTART_HELP,
	);

	program.addCommand(createAgentCommand(store, daemon));
	program.addCommand(createAdminCommand(store));
	program.addCommand(createModelCommand(store));
	program.addCommand(createChannelCommand(store));
	program.addCommand(createPairCommand(store));
	program.addCommand(createSessionCommand(store));

	commandExamples(
		(() => {
			const doctor = program.command("doctor [agent]");
			configureCommandOutput(doctor);
			return doctor;
		})()
			.description("Check configuration and runtime problems.")
			.action(async (agentRef?: string) => {
				await handleDoctor(agentRef, store);
			}),
		DOCTOR_HELP,
	);

	commandExamples(
		(() => {
			const status = program.command("status");
			configureCommandOutput(status);
			return status;
		})()
			.description("Show shared daemon status and an overall agent summary.")
			.action(async () => {
				await handleStatus(store);
			}),
		STATUS_HELP,
	);

	commandExamples(
		(() => {
			const start = program.command("start");
			configureCommandOutput(start);
			return start;
		})()
			.description("Start the shared background runtime daemon.")
			.action(async () => {
				await handleRuntimeStart(store);
			}),
		START_HELP,
	);

	commandExamples(
		(() => {
			const stop = program.command("stop");
			configureCommandOutput(stop);
			return stop;
		})()
			.description("Stop the shared background runtime daemon.")
			.action(async () => {
				await handleRuntimeStop(store);
			}),
		STOP_HELP,
	);

	commandExamples(
		(() => {
			const restart = program.command("restart");
			configureCommandOutput(restart);
			return restart;
		})()
			.description("Restart the shared background runtime daemon.")
			.action(async () => {
				await handleRuntimeRestart(store);
			}),
		RESTART_HELP,
	);

	return program;
}

function findPublicCommand(program: Command, name: string): Command | undefined {
	return program.commands.find((command) => command.name() === name);
}

export async function runNekoclawCommand(args: string[]): Promise<void> {
	const internal = args[0] === "__nekoclaw_internal";
	const normalized = internal ? args.slice(1) : args;
	const [scope, action] = normalized;
	const store = new JsonNekoclawStore();
	const daemon = new NekoclawDaemon(store);

	try {
		if (internal) {
			if (scope === "runtime") {
				await runInternalRuntime(store);
				return;
			}
			if (scope === "worker" && action === "run") {
				await runInternalWorker();
				return;
			}
			throw new Error(`Unknown internal action "${scope ?? ""}"`);
		}

		const program = createProgram(store, daemon);
		program.exitOverride();
		if (args.length === 0) {
			program.outputHelp();
			return;
		}
		if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
			program.outputHelp();
			return;
		}
		if (args.length === 1) {
			const nested = findPublicCommand(program, args[0]);
			if (nested && nested.commands.length > 0) {
				nested.outputHelp();
				return;
			}
		}
		await program.parseAsync(args, { from: "user" });
	} catch (error) {
		if (error instanceof CommanderError) {
			process.exitCode = error.exitCode || 1;
			return;
		}
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(message));
		process.exitCode = 1;
	}
}
