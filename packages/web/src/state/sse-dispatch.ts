import { Value } from "typebox/value";
import type { PixiesErrorTag } from "@pixies/core";
import { isToolProgress, PixiesErrorTagSchema } from "@pixies/core";
import type { SSEEvent } from "@pixies/protocol";
import { errorToToastCopy } from "../lib/error-copy.ts";
import { joinContentText, type ChatAction } from "./chat-reducer.ts";

export function dispatchSseEvent(
	evt: SSEEvent,
	dispatch: (action: ChatAction) => void,
	onConversationCreated?: (id: string) => void,
): void {
	switch (evt.event) {
		case "conversation_created":
			dispatch({ type: "CONVERSATION_CREATED", id: evt.data.id });
			onConversationCreated?.(evt.data.id);
			break;
		case "tool_execution_start":
			dispatch({
				type: "TOOL_START",
				toolCallId: evt.data.toolCallId,
				toolName: evt.data.toolName,
				args: evt.data.args,
			});
			break;
		case "tool_execution_update": {
			if (isToolProgress(evt.data.details))
				dispatch({
					type: "TOOL_UPDATE",
					toolCallId: evt.data.toolCallId,
					progress: evt.data.details,
				});
			break;
		}
		case "tool_execution_end":
			dispatch({
				type: "TOOL_END",
				toolCallId: evt.data.toolCallId,
				isError: evt.data.isError,
				resultText: joinContentText(evt.data.result.content, "\n") || null,
				details: evt.data.result.details,
			});
			break;
		case "done":
			dispatch({ type: "STREAM_DONE", responseTimeMs: evt.data.durationMs });
			break;
		case "error": {
			const rawTag = evt.data.errorTag;
			const tag: PixiesErrorTag | undefined =
				rawTag !== undefined && Value.Check(PixiesErrorTagSchema, rawTag) ? rawTag : undefined;
			dispatch({
				type: "SET_ERROR",
				message: errorToToastCopy({
					tag,
					defaultMessage: evt.data.message,
					details: evt.data.details,
				}),
			});
			break;
		}
	}
}
