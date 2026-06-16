import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { isToolProgress, toClientAssistantMessage } from "@pixies/core";
import type { SSEEvent } from "@pixies/core";

export function translateAgentEvent(event: AgentEvent): SSEEvent[] {
	switch (event.type) {
		case "message_start":
			return event.message.role === "assistant" ? [{ event: "message_start", data: {} }] : [];
		case "message_update":
			return event.assistantMessageEvent.type === "text_delta"
				? [{ event: "text_delta", data: { delta: event.assistantMessageEvent.delta } }]
				: [];
		case "message_end":
			return event.message.role === "assistant"
				? [{ event: "message_end", data: { message: toClientAssistantMessage(event.message) } }]
				: [];
		case "tool_execution_start":
			return [
				{
					event: "tool_execution_start",
					data: { toolCallId: event.toolCallId, toolName: event.toolName, args: event.args },
				},
			];
		case "tool_execution_update": {
			const details = event.partialResult?.details;
			// Forward only validated progress payloads; drop malformed/empty updates.
			if (!isToolProgress(details)) return [];
			return [
				{
					event: "tool_execution_update",
					data: { toolCallId: event.toolCallId, details },
				},
			];
		}
		case "tool_execution_end":
			return [
				{
					event: "tool_execution_end",
					data: { toolCallId: event.toolCallId, isError: event.isError, result: event.result },
				},
			];
		default:
			return [];
	}
}
