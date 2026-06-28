import { useCallback, useReducer, useRef } from "react";
import { isAbortError } from "@pixies/core";
import { createConversationStream, sendMessageStream } from "../api/conversations.ts";
import { toolResultCount } from "../lib/posthog-capture.ts";
import { mapReducer, initialMapState, type Layer } from "../state/map-reducer.ts";
import { dispatchMapEvent } from "../state/sse-dispatch.ts";

/**
 * Map-centric state machine — replaces the chat {@link useChat} hook with a
 * layer-stack model. Streams SSE events, dispatches map actions, and exposes
 * the same abort/reset/loadTranscript surface so existing pages can swap
 * providers without changing their wiring.
 */
export function useMapSearch() {
	const [state, dispatch] = useReducer(mapReducer, initialMapState);
	const stateRef = useRef(state);
	stateRef.current = state;
	const abortRef = useRef<AbortController | null>(null);
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
			hadOutputRef.current = false;
			dispatch({ type: "SEND_MESSAGE", text: message });

			const conversationId = stateRef.current.conversationId;
			const stream = conversationId
				? sendMessageStream(conversationId, message, controller.signal)
				: createConversationStream(message, controller.signal);

			const toolNames = new Map<string, string>();

			try {
				for await (const evt of stream) {
					// Capture tool name on start for error/empty analytics and
					// dispatch attribution (tool_execution_end doesn't carry a name).
					if (evt.event === "tool_execution_start") {
						hadOutputRef.current = true;
						toolNames.set(evt.data.toolCallId, evt.data.toolName);
					}

					// Product-analytics callbacks — fires before dispatch so
					// the reducer doesn't need to understand analytics.
					if (evt.event === "tool_execution_end") {
						const toolName = toolNames.get(evt.data.toolCallId);
						if (toolName) {
							if (evt.data.isError) {
								opts?.onToolError?.(toolName);
							} else {
								const count = toolResultCount(toolName, evt.data.result.details);
								if (count !== undefined)
									opts?.onToolEmpty?.({ tool_name: toolName, result_count: count });
							}
						}
					}

					dispatchMapEvent(evt, dispatch, toolNames, opts?.onConversationCreated);
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

	const loadTranscript = useCallback((conversationId: string, layers: Layer[]) => {
		dispatch({ type: "LOAD_TRANSCRIPT", conversationId, layers });
	}, []);

	return { state, sendMessage, abort, reset, loadTranscript, hadOutputRef };
}
