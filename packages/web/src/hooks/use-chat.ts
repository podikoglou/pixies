import { useCallback, useReducer, useRef, type MutableRefObject } from "react";
import { isAbortError } from "@pixies/core";
import { createConversationStream, sendMessageStream } from "../api/conversations.ts";
import { toolResultCount } from "../lib/posthog-capture.ts";
import {
	chatReducer,
	initialChatState,
	type ChatState,
	type TimelineItem,
} from "../state/chat-reducer.ts";
import { dispatchSseEvent } from "../state/sse-dispatch.ts";

export interface UseChatReturn {
	state: ChatState;
	sendMessage: (
		message: string,
		opts?: {
			onConversationCreated?: (id: string) => void;
			onToolError?: (toolName: string) => void;
			onToolEmpty?: (props: { tool_name: string; result_count: number }) => void;
		},
	) => Promise<void>;
	abort: () => void;
	reset: () => void;
	loadTranscript: (conversationId: string, items: TimelineItem[]) => void;
	hadOutputRef: MutableRefObject<boolean>;
}

export function useChat(): UseChatReturn {
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
				onToolEmpty?: (props: { tool_name: string; result_count: number }) => void;
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
					} else if (evt.event === "tool_execution_end") {
						const toolName = toolNames.get(evt.data.toolCallId);
						if (toolName) {
							if (evt.data.isError) {
								opts?.onToolError?.(toolName);
							} else {
								// Success path: count the features for the empty-rate signal
								// (undefined → not a data-fetch tool or a busy soft-failure,
								// in which case no `tool_empty` fires).
								const count = toolResultCount(toolName, evt.data.result.details);
								if (count !== undefined)
									opts?.onToolEmpty?.({ tool_name: toolName, result_count: count });
							}
						}
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
