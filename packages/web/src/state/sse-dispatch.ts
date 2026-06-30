import { Value } from "typebox/value";
import type { PixiesErrorTag } from "@pixies/core";
import { isToolProgress, PixiesErrorTagSchema } from "@pixies/core";
import type { SSEEvent } from "@pixies/protocol";
import { errorToToastCopy } from "../lib/error-copy.ts";
import { joinContentText, type ChatAction } from "./chat-reducer.ts";
import type { MapAction } from "./map-reducer.ts";

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

/**
 * Map-centric dispatch: translates SSE events into {@link MapAction} for the
 * persistent-map state model. Only events that change the map or its metadata
 * are dispatched — streaming text, tool-start signals, and queued updates have
 * no visual effect in the map-centric UI and are silently dropped.
 *
 * @param toolNames  Caller-maintained map from `toolCallId` → `toolName`,
 *   populated on `tool_execution_start` events before calling this function.
 */
export function dispatchMapEvent(
	evt: SSEEvent,
	dispatch: (action: MapAction) => void,
	toolNames: Map<string, string>,
	onConversationCreated?: (id: string) => void,
): void {
	switch (evt.event) {
		case "conversation_created":
			dispatch({ type: "CONVERSATION_CREATED", id: evt.data.id });
			onConversationCreated?.(evt.data.id);
			break;

		case "tool_execution_end":
			dispatch({
				type: "TOOL_END",
				toolName: toolNames.get(evt.data.toolCallId) ?? "",
				isError: evt.data.isError,
				details: evt.data.result.details,
			});
			break;

		case "done":
			dispatch({ type: "STREAM_DONE" });
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

		// message_start, text_delta, message_end, tool_execution_start,
		// tool_execution_update — no visual effect in the map-centric UI.
		default:
			break;
	}
}
