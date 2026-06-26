import type { Dispatch } from "react";
import { useCallback, useReducer, useRef } from "react";
import { Value } from "typebox/value";
import type { PixiesErrorTag, SSEEvent } from "@pixies/core";
import { isAbortError, isToolProgress, PixiesErrorTagSchema } from "@pixies/core";
import { createConversationStream, sendMessageStream } from "../api/conversations.ts";
import { errorToToastCopy } from "../lib/error-copy.ts";
import {
	chatReducer,
	initialChatState,
	joinContentText,
	type ChatAction,
	type TimelineItem,
} from "../state/chat-reducer.ts";

export function dispatchSseEvent(
	evt: SSEEvent,
	dispatch: Dispatch<ChatAction>,
	onConversationCreated?: (id: string) => void,
	startTime?: number,
): void {
	switch (evt.event) {
		case "conversation_created":
			dispatch({ type: "CONVERSATION_CREATED", id: evt.data.id });
			// Fire navigation intent here, from the event that produces the state
			// change — not via a state-watching useEffect downstream (issue #51).
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

export function useChat() {
	const [state, dispatch] = useReducer(chatReducer, initialChatState);
	const stateRef = useRef(state);
	stateRef.current = state;
	const abortRef = useRef<AbortController | null>(null);
	const startTimeRef = useRef<number>(0);
	const hadOutputRef = useRef(false);

	const sendMessage = useCallback(
		async (
			message: string,
			opts?: {
				onConversationCreated?: (id: string) => void;
				onToolError?: (toolName: string) => void;
			},
		) => {
			if (!message.trim()) return;
			const controller = new AbortController();
			abortRef.current = controller;
			startTimeRef.current = Date.now();
			hadOutputRef.current = false;
			dispatch({ type: "SEND_MESSAGE", text: message });

			const conversationId = stateRef.current.conversationId;
			const stream = conversationId
				? sendMessageStream(conversationId, message, controller.signal)
				: createConversationStream(message, controller.signal);

			// `tool_execution_end` carries only toolCallId + isError — the tool name
			// arrived earlier on `tool_execution_start`, so remember it to attribute
			// any error to the right tool for product analytics.
			const toolNames = new Map<string, string>();
			try {
				for await (const evt of stream) {
					if (evt.event === "tool_execution_start") {
						hadOutputRef.current = true;
						toolNames.set(evt.data.toolCallId, evt.data.toolName);
					} else if (evt.event === "tool_execution_end" && evt.data.isError) {
						const toolName = toolNames.get(evt.data.toolCallId);
						if (toolName) opts?.onToolError?.(toolName);
					}
					dispatchSseEvent(evt, dispatch, opts?.onConversationCreated, startTimeRef.current);
				}
			} catch (err) {
				if (isAbortError(err)) {
					dispatch({ type: "STREAM_DONE" });
				} else {
					dispatch({
						type: "SET_ERROR",
						message: err instanceof Error ? err.message : String(err),
					});
				}
			} finally {
				abortRef.current = null;
			}
		},
		[],
	);

	const abort = useCallback(() => {
		abortRef.current?.abort();
	}, []);

	const reset = useCallback(() => {
		abortRef.current?.abort();
		dispatch({ type: "RESET" });
	}, []);

	const loadTranscript = useCallback((conversationId: string, items: TimelineItem[]) => {
		dispatch({ type: "LOAD_TRANSCRIPT", conversationId, items });
	}, []);

	return { state, sendMessage, abort, reset, loadTranscript, hadOutputRef };
}
