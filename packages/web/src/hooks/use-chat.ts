import type { Dispatch } from "react";
import { useCallback, useReducer, useRef } from "react";
import type { SSEEvent } from "@pixies/core";
import { isToolProgress } from "@pixies/core";
import { createConversationStream, sendMessageStream } from "../api/conversations.ts";
import {
	chatReducer,
	initialChatState,
	joinContentText,
	type ChatAction,
	type TimelineItem,
} from "../state/chat-reducer.ts";

function isAbortError(err: unknown): boolean {
	if (err instanceof Error && err.name === "AbortError") return true;
	return (
		typeof DOMException !== "undefined" && err instanceof DOMException && err.name === "AbortError"
	);
}

export function dispatchSseEvent(
	evt: SSEEvent,
	dispatch: Dispatch<ChatAction>,
	onConversationCreated?: (id: string) => void,
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
		case "message_end":
			dispatch({ type: "MESSAGE_END", text: joinContentText(evt.data.message.content, "") });
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
			dispatch({ type: "STREAM_DONE" });
			break;
		case "error":
			dispatch({ type: "SET_ERROR", message: evt.data.message });
			break;
	}
}

export function useChat() {
	const [state, dispatch] = useReducer(chatReducer, initialChatState);
	const stateRef = useRef(state);
	stateRef.current = state;
	const abortRef = useRef<AbortController | null>(null);

	const sendMessage = useCallback(
		async (message: string, opts?: { onConversationCreated?: (id: string) => void }) => {
			if (!message.trim()) return;
			const controller = new AbortController();
			abortRef.current = controller;
			dispatch({ type: "SEND_MESSAGE", text: message });

			const conversationId = stateRef.current.conversationId;
			const stream = conversationId
				? sendMessageStream(conversationId, message, controller.signal)
				: createConversationStream(message, controller.signal);

			try {
				for await (const evt of stream)
					dispatchSseEvent(evt, dispatch, opts?.onConversationCreated);
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
		dispatch({ type: "RESET" });
	}, []);

	const loadTranscript = useCallback((conversationId: string, items: TimelineItem[]) => {
		dispatch({ type: "LOAD_TRANSCRIPT", conversationId, items });
	}, []);

	return { state, sendMessage, abort, reset, loadTranscript };
}
