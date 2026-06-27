import { Value } from "typebox/value";
import type { PixiesErrorTag, SSEEvent } from "@pixies/core";
import { isToolProgress, PixiesErrorTagSchema } from "@pixies/core";
import { errorToToastCopy } from "../lib/error-copy.ts";
import { joinContentText, type ChatAction } from "./chat-reducer.ts";

/**
 * The seam between the SSE transport and the reducer: maps each wire event to
 * the {@link ChatAction} it produces, dispatching it through `dispatch`.
 *
 * Pure translation with one side-effect port — `onConversationCreated` — that
 * the caller wires for navigation, since `conversation_created` drives both a
 * state change and a route transition.
 */
export function dispatchSseEvent(
	evt: SSEEvent,
	dispatch: (action: ChatAction) => void,
	onConversationCreated?: (id: string) => void,
	startTime?: number,
): void {
	switch (evt.event) {
		case "conversation_created":
			dispatch({ type: "CONVERSATION_CREATED", id: evt.data.id });
			// Fire navigation intent here, from the event that produces the state
			// change — not via a state-watching useEffect downstream.
			onConversationCreated?.(evt.data.id);
			break;
		case "message_start":
			dispatch({ type: "MESSAGE_START" });
			break;
		case "text_delta":
			dispatch({ type: "TEXT_DELTA", delta: evt.data.delta });
			break;
		case "message_end": {
			const responseTimeMs = startTime ? Date.now() - startTime : undefined;
			dispatch({
				type: "MESSAGE_END",
				text: joinContentText(evt.data.message.content, ""),
				responseTimeMs,
			});
			break;
		}
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
			// Parse the raw `errorTag` string through PixiesErrorTagSchema rather
			// than `as`-casting it, so an unknown tag becomes `undefined` here
			// instead of leaning on errorToToastCopy's `default` arm downstream.
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
