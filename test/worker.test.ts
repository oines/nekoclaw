import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage, Message, UserMessage } from "@mariozechner/pi-ai";
import type { WorkerPayload } from "../src/types.js";

function createPayload(): WorkerPayload {
	return {
		agent: {
			agentId: "agent-1",
			slug: "test-agent",
			image: "node:22-bookworm-slim",
			containerName: "nekoclaw-test-agent",
			enabled: true,
			createdAt: "2026-03-29T00:00:00.000Z",
			updatedAt: "2026-03-29T00:00:00.000Z",
		},
		job: {
			jobId: "job-1",
			agentId: "agent-1",
			kind: "inbound",
			sessionRecordId: "session-1",
			sessionKey: "agent:test-agent:telegram:group:1",
			createdAt: "2026-03-29T00:00:00.000Z",
			event: {
				eventType: "message.created",
				channelType: "telegram",
				chatId: "1",
				chatKind: "group",
				messageId: "2",
				sender: { externalId: "user-1", displayName: "Alice" },
				blocks: [{ kind: "text", text: "hello" }],
				occurredAt: "2026-03-29T00:00:00.000Z",
			},
		},
		currentSession: {
			sessionRecordId: "session-1",
			agentId: "agent-1",
			sessionKey: "agent:test-agent:telegram:group:1",
			channelType: "telegram",
			externalConversationId: "1",
			chatKind: "group",
			resetGeneration: 0,
			status: "active",
			createdAt: "2026-03-29T00:00:00.000Z",
			updatedAt: "2026-03-29T00:00:00.000Z",
		},
		capabilities: {
			text: true,
			media: true,
			reply: true,
			edit: true,
			delete: true,
			typing: true,
		},
		runtimeDirectory: {
			contacts: [],
			groups: [],
			groupMembers: {},
			availableChannels: ["telegram"],
		},
		serverTimezone: "Asia/Shanghai",
		sessionCrons: [],
	};
}

function createAssistantErrorMessage(errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: "mock",
		provider: "mock",
		model: "mock-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
	};
}

describe("worker runtime", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.resetModules();
	});

	it("treats no_reply as terminal and prunes trailing session artifacts", async () => {
		const previousUserMessage: UserMessage = {
			role: "user",
			content: [{ type: "text", text: "previous context" }],
			timestamp: 1,
		};
		const rewriteFile = vi.fn();
		const sessionManagerState = {
			sessionFile: undefined as string | undefined,
			fileEntries: [
				{
					type: "session",
					version: 1,
					id: "session-file",
					timestamp: "2026-03-29T00:00:00.000Z",
					cwd: "/workspace",
				},
				{
					type: "message",
					id: "entry-prev",
					parentId: null,
					timestamp: "2026-03-29T00:00:00.000Z",
					message: previousUserMessage,
				},
			] as Array<{ type: string; id?: string; message?: Message }>,
			byId: new Map<string, { type: string; id?: string; message?: Message }>(),
			leafId: "entry-prev" as string | null,
			setSessionFile(path: string) {
				this.sessionFile = path;
			},
			_buildIndex() {
				this.byId = new Map();
				this.leafId = null;
				for (const entry of this.fileEntries) {
					if (entry.type === "session" || !entry.id) {
						continue;
					}
					this.byId.set(entry.id, entry);
					this.leafId = entry.id;
				}
			},
			_rewriteFile: rewriteFile,
		};
		sessionManagerState._buildIndex();

		let customTools: ToolDefinition[] = [];
		let afterToolCall:
			| ((context: {
					assistantMessage: AssistantMessage;
					toolCall: Extract<AssistantMessage["content"][number], { type: "toolCall" }>;
					args: unknown;
					result: { content: { type: "text"; text: string }[]; details: unknown };
					isError: boolean;
					context: { messages: Message[]; systemPrompt: string; tools: [] };
			  }) => Promise<unknown>)
			| undefined;
		const sessionState = {
			messages: [previousUserMessage] as Message[],
			error: undefined as string | undefined,
		};

		vi.doMock("@mariozechner/pi-coding-agent", () => {
			class FakeSettingsManager {
				static inMemory() {
					return {};
				}
			}

			class FakeAuthStorage {
				static inMemory() {
					return {};
				}
			}

			class FakeModelRegistry {
				constructor() {}
				find() {
					return undefined;
				}
			}

			class FakeDefaultResourceLoader {
				constructor() {}
				async reload() {}
			}

			class FakeSessionManager {
				static create() {
					return sessionManagerState;
				}
			}

			return {
				AuthStorage: FakeAuthStorage,
				codingTools: [],
				createAgentSession: vi.fn(async (config: { customTools: ToolDefinition[] }) => {
					customTools = config.customTools;
					return {
						session: {
							state: sessionState,
							agent: {
								state: sessionState,
								setSystemPrompt: vi.fn(),
								setAfterToolCall: vi.fn((value) => {
									afterToolCall = value;
								}),
								waitForIdle: vi.fn(async () => undefined),
							},
							bindExtensions: vi.fn(async () => undefined),
							prompt: vi.fn(async () => {
								const assistantToolCall: AssistantMessage = {
									role: "assistant",
									content: [{ type: "toolCall", id: "tool-1", name: "no_reply", arguments: {} }],
									timestamp: Date.now(),
								};
								sessionState.messages.push(assistantToolCall);
								sessionManagerState.fileEntries.push({
									type: "message",
									id: "entry-no-reply",
									parentId: sessionManagerState.leafId,
									timestamp: "2026-03-29T00:00:01.000Z",
									message: assistantToolCall,
								});
								sessionManagerState._buildIndex();

								const noReplyTool = customTools.find((tool) => tool.name === "no_reply");
								if (!noReplyTool || !afterToolCall) {
									throw new Error("test harness did not capture no_reply tool");
								}
								const result = await noReplyTool.execute(
									"tool-1",
									{},
									undefined,
									undefined,
									undefined as never,
								);
								try {
									await afterToolCall({
										assistantMessage: assistantToolCall,
										toolCall: assistantToolCall.content[0],
										args: {},
										result: {
											content: result.content as { type: "text"; text: string }[],
											details: result.details,
										},
										isError: false,
										context: { messages: sessionState.messages, systemPrompt: "", tools: [] },
									});
								} catch (error) {
									const message = error instanceof Error ? error.message : String(error);
									sessionState.messages.push(createAssistantErrorMessage(message));
									sessionState.error = message;
								}
							}),
						},
					};
				}),
				DefaultResourceLoader: FakeDefaultResourceLoader,
				ModelRegistry: FakeModelRegistry,
				SessionManager: FakeSessionManager,
				SettingsManager: FakeSettingsManager,
			};
		});

		const { runWorker } = await import("../src/runtime/worker.js");
		const result = await runWorker(createPayload());

		expect(result).toEqual({
			outbound: {},
			toolActions: [{ kind: "no_reply" }],
			stopReason: "no_reply",
		});
		expect(sessionState.messages).toEqual([previousUserMessage]);
		expect(sessionState.error).toBeUndefined();
		expect(sessionManagerState.fileEntries).toHaveLength(2);
		expect(sessionManagerState.fileEntries[1]).toMatchObject({
			type: "message",
			id: "entry-prev",
			message: previousUserMessage,
		});
		expect(sessionManagerState.leafId).toBe("entry-prev");
		expect(rewriteFile).toHaveBeenCalledTimes(1);
	});

	it("includes explicit mention metadata in the current inbound prompt", async () => {
		let capturedPrompt = "";

		vi.doMock("@mariozechner/pi-coding-agent", () => {
			class FakeSettingsManager {
				static inMemory() {
					return {};
				}
			}

			class FakeAuthStorage {
				static inMemory() {
					return {};
				}
			}

			class FakeModelRegistry {
				constructor() {}
				find() {
					return undefined;
				}
			}

			class FakeDefaultResourceLoader {
				constructor() {}
				async reload() {}
			}

			class FakeSessionManager {
				static create() {
					return {
						sessionFile: undefined as string | undefined,
						fileEntries: [],
						byId: new Map(),
						leafId: null,
						setSessionFile(path: string) {
							this.sessionFile = path;
						},
						_buildIndex() {},
						_rewriteFile() {},
					};
				}
			}

			return {
				AuthStorage: FakeAuthStorage,
				codingTools: [],
				createAgentSession: vi.fn(async () => {
					const sessionState = { messages: [] as Message[] };
					return {
						session: {
							state: sessionState,
							agent: {
								state: sessionState,
								setSystemPrompt: vi.fn(),
								setAfterToolCall: vi.fn(),
								waitForIdle: vi.fn(async () => undefined),
							},
							bindExtensions: vi.fn(async () => undefined),
							prompt: vi.fn(async (text: string) => {
								capturedPrompt = text;
								sessionState.messages.push({
									role: "assistant",
									content: [{ type: "text", text: "ok" }],
									timestamp: Date.now(),
								});
							}),
						},
					};
				}),
				DefaultResourceLoader: FakeDefaultResourceLoader,
				ModelRegistry: FakeModelRegistry,
				SessionManager: FakeSessionManager,
				SettingsManager: FakeSettingsManager,
			};
		});

		const { runWorker } = await import("../src/runtime/worker.js");
		const payload = createPayload();
		payload.job.event.mentionedUsernames = ["mock_bot", "db_admin"];
		payload.job.event.blocks = [{ kind: "text", text: "@mock_bot 让 @db_admin 看看数据库" }];

		const result = await runWorker(payload);

		expect(result.outbound.text).toBe("ok");
		expect(capturedPrompt).toContain("Content:");
		expect(capturedPrompt).toContain("- Mentions: @mock_bot, @db_admin");
		expect(capturedPrompt).toContain("- Text: @mock_bot 让 @db_admin 看看数据库");
	});
});
