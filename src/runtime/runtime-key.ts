import type { AgentSpec, ChannelSpec, ChannelType } from "../types.js";

export function getRuntimeKey(
	agent: Pick<AgentSpec, "agentId"> | string,
	channel: Pick<ChannelSpec, "type"> | ChannelType,
): string {
	const agentId = typeof agent === "string" ? agent : agent.agentId;
	const channelType = typeof channel === "string" ? channel : channel.type;
	return `${agentId}:${channelType}`;
}
