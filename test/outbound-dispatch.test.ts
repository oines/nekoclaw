import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OutboundDispatchService } from "../src/runtime/outbound-dispatch.js";
import type { AgentSpec, ChannelPlugin, ChannelType, ReplyPayload, SessionRecord } from "../src/types.js";
import { NEKOCLAW_CONTAINER_WORKSPACE_DIR } from "../src/config.js";

describe("OutboundDispatchService path rebasing", () => {
	const mockAgent: AgentSpec = {
		agentId: "agent-1",
		slug: "test-agent",
		image: "node:22",
		enabled: true,
		createdAt: "",
		updatedAt: "",
	};

	const mockSession: SessionRecord = {
		sessionRecordId: "session-1",
		agentId: "agent-1",
		channelType: "telegram",
		externalConversationId: "123",
		chatKind: "dm",
		sessionKey: "agent:test-agent:telegram:direct:123",
		resetGeneration: 0,
		status: "active",
		createdAt: "",
		updatedAt: "",
	};

	const mockStore = {
		getWorkspaceRoot: vi.fn().mockReturnValue("/host/workspaces/test-agent"),
		getChannel: vi.fn((_agentId: string, channelType: ChannelType) => ({ type: channelType })),
		audit: vi.fn(),
		getAgentByRef: vi.fn().mockReturnValue(mockAgent),
	};

	const mockPluginActions = {
		send: vi.fn().mockResolvedValue([]),
		reply: vi.fn().mockResolvedValue([]),
		edit: vi.fn().mockResolvedValue(undefined),
		delete: vi.fn().mockResolvedValue(undefined),
		typing: vi.fn().mockResolvedValue(undefined),
	};

	const mockPlugin: ChannelPlugin = {
		type: "telegram",
		capabilities: { text: true, media: true, reply: true, edit: true, delete: true, typing: true },
		actions: mockPluginActions,
		outbound: {
			send: vi.fn().mockResolvedValue([]),
		},
		threading: {} as any,
		pairing: {} as any,
		triggering: {} as any,
		resolveSessionAddress: vi.fn(),
	};

	const mockNapcatPluginActions = {
		send: vi.fn().mockResolvedValue([]),
		reply: vi.fn().mockResolvedValue([]),
		edit: vi.fn().mockResolvedValue(undefined),
		delete: vi.fn().mockResolvedValue(undefined),
		typing: vi.fn().mockResolvedValue(undefined),
	};

	const mockNapcatPlugin: ChannelPlugin = {
		type: "napcat",
		capabilities: { text: true, media: true, reply: true, edit: true, delete: true, typing: true },
		actions: mockNapcatPluginActions,
		outbound: {
			send: vi.fn().mockResolvedValue([]),
		},
		threading: {} as any,
		pairing: {} as any,
		triggering: {} as any,
		resolveSessionAddress: vi.fn(),
	};

	const plugins = new Map<string, ChannelPlugin>([
		["agent-1:telegram", mockPlugin],
		["agent-1:napcat", mockNapcatPlugin],
	]);

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("rebases container paths to host paths in sendToSession", async () => {
		const service = new OutboundDispatchService(mockStore as any, plugins);
		const payload: ReplyPayload = {
			text: "here is a file",
			attachments: [
				{
					kind: "image",
					filePath: join(NEKOCLAW_CONTAINER_WORKSPACE_DIR, "attachments/pic.jpg"),
				},
			],
		};

		await service.sendToSession(mockAgent, mockSession, {} as any, payload);

		const call = (mockPlugin.outbound.send as any).mock.calls[0][0];
		expect(call.payload.attachments[0].filePath).toBe("/host/workspaces/test-agent/attachments/pic.jpg");
	});

	it("rebases container paths in executeToolActions (send and reply)", async () => {
		const service = new OutboundDispatchService(mockStore as any, plugins);
		const actions: any[] = [
			{
				kind: "send",
				payload: {
					attachments: [{ kind: "image", filePath: "/workspace/file1.jpg" }],
				},
			},
			{
				kind: "reply",
				replyToId: "42",
				payload: {
					attachments: [{ kind: "file", filePath: "/workspace/docs/spec.pdf" }],
				},
			},
		];

		await service.executeToolActions(mockAgent, mockSession, actions);

		expect(mockPluginActions.send).toHaveBeenCalledWith(
			expect.objectContaining({
				payload: expect.objectContaining({
					attachments: [expect.objectContaining({ filePath: "/host/workspaces/test-agent/file1.jpg" })],
				}),
			}),
		);
		expect(mockPluginActions.reply).toHaveBeenCalledWith(
			expect.objectContaining({
				payload: expect.objectContaining({
					attachments: [expect.objectContaining({ filePath: "/host/workspaces/test-agent/docs/spec.pdf" })],
				}),
			}),
		);
	});

	it("dispatches send_targeted to the plugin that matches the explicit target ref", async () => {
		const service = new OutboundDispatchService(mockStore as any, plugins);
		const actions: any[] = [
			{
				kind: "send_targeted",
				target: "napcat:group:8888",
				payload: {
					text: "hello group",
					attachments: [{ kind: "file", filePath: "/workspace/docs/notes.txt" }],
				},
			},
		];

		await service.executeToolActions(mockAgent, mockSession, actions);

		expect(mockNapcatPluginActions.send).toHaveBeenCalledWith({
			chatId: "8888",
			chatKind: "group",
			payload: {
				text: "hello group",
				attachments: [{ kind: "file", filePath: "/host/workspaces/test-agent/docs/notes.txt" }],
			},
		});
		expect(mockPluginActions.send).not.toHaveBeenCalled();
	});

	it("leaves non-container paths and URLs untouched", async () => {
		const service = new OutboundDispatchService(mockStore as any, plugins);
		const payload: ReplyPayload = {
			attachments: [
				{ kind: "image", url: "https://example.com/pic.jpg" },
				{ kind: "file", filePath: "/some/other/path.txt" },
			],
		};

		await service.sendToSession(mockAgent, mockSession, {} as any, payload);

		const call = (mockPlugin.outbound.send as any).mock.calls[0][0];
		expect(call.payload.attachments[0].url).toBe("https://example.com/pic.jpg");
		expect(call.payload.attachments[1].filePath).toBe("/some/other/path.txt");
	});
});
