import type { AgentEvent } from "@earendil-works/pi-agent-core";

export type SseEvent =
	| { event: "conversation_created"; data: { id: string } }
	| { event: "message_start"; data: Record<string, never> }
	| { event: "text_delta"; data: { delta: string } }
	| { event: "message_end"; data: { message: unknown } }
	| { event: "tool_execution_start"; data: { toolCallId: string; toolName: string; args: unknown } }
	| { event: "tool_execution_update"; data: { toolCallId: string; details: unknown } }
	| { event: "tool_execution_end"; data: { toolCallId: string; isError: boolean; result: unknown } }
	| { event: "done"; data: Record<string, never> }
	| { event: "error"; data: { message: string } };

export function translateAgentEvent(event: AgentEvent): SseEvent[] {
	switch (event.type) {
		case "message_start":
			return event.message.role === "assistant" ? [{ event: "message_start", data: {} }] : [];
		case "message_update":
			return event.assistantMessageEvent.type === "text_delta"
				? [{ event: "text_delta", data: { delta: event.assistantMessageEvent.delta } }]
				: [];
		case "message_end":
			return event.message.role === "assistant" ? [{ event: "message_end", data: { message: event.message } }] : [];
		case "tool_execution_start":
			return [{ event: "tool_execution_start", data: { toolCallId: event.toolCallId, toolName: event.toolName, args: event.args } }];
		case "tool_execution_update":
			return [{ event: "tool_execution_update", data: { toolCallId: event.toolCallId, details: event.partialResult?.details } }];
		case "tool_execution_end":
			return [{ event: "tool_execution_end", data: { toolCallId: event.toolCallId, isError: event.isError, result: event.result } }];
		default:
			return [];
	}
}
