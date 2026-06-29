import type { ConversationTranscript } from "../api/conversations.ts";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import {
	parseToolResult,
	isBusyResult,
	TextContentBlock,
	type ToolProgress,
	type ToolResult,
} from "@pixies/core";

type TextBlock = Static<typeof TextContentBlock>;

export type TimelineItem =
	| { kind: "user-message"; text: string; responseTimeMs?: number }
	| { kind: "assistant-message"; text: string; responseTimeMs?: number }
	| {
			kind: "tool-call";
			toolCallId: string;
			toolName: string;
			args: unknown;
			status: "running" | "done" | "error" | "warning";
			queued: boolean;
			resultText: string | null;
			result: ToolResult;
			responseTimeMs?: number;
	  };

export interface ChatState {
	conversationId: string | null;
	items: TimelineItem[];
	streamingText: string;
	isStreaming: boolean;
	error: string | null;
}

export const initialChatState: ChatState = {
	conversationId: null,
	items: [],
	streamingText: "",
	isStreaming: false,
	error: null,
};

export type ChatAction =
	| { type: "LOAD_TRANSCRIPT"; conversationId: string; items: TimelineItem[] }
	| { type: "SEND_MESSAGE"; text: string }
	| { type: "CONVERSATION_CREATED"; id: string }
	| { type: "MESSAGE_START" }
	| { type: "TEXT_DELTA"; delta: string }
	| { type: "MESSAGE_END"; text: string; responseTimeMs?: number }
	| { type: "TOOL_START"; toolCallId: string; toolName: string; args: unknown }
	| { type: "TOOL_UPDATE"; toolCallId: string; progress: ToolProgress }
	| {
			type: "TOOL_END";
			toolCallId: string;
			isError: boolean;
			resultText: string | null;
			details: unknown;
	  }
	| { type: "STREAM_DONE"; responseTimeMs?: number }
	| { type: "SET_ERROR"; message: string }
	| { type: "RESET" };

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
	switch (action.type) {
		case "LOAD_TRANSCRIPT":
			return {
				...state,
				conversationId: action.conversationId,
				items: action.items,
				streamingText: "",
				isStreaming: false,
				error: null,
			};
		case "SEND_MESSAGE":
			return {
				...state,
				items: [...state.items, { kind: "user-message", text: action.text }],
				streamingText: "",
				isStreaming: true,
				error: null,
			};
		case "CONVERSATION_CREATED":
			return { ...state, conversationId: action.id };
		case "MESSAGE_START":
			return { ...state, streamingText: "" };
		case "TEXT_DELTA":
			return { ...state, streamingText: state.streamingText + action.delta };
		case "MESSAGE_END":
			return { ...state, streamingText: "" };
		case "TOOL_START":
			return {
				...state,
				items: [
					...state.items,
					{
						kind: "tool-call",
						toolCallId: action.toolCallId,
						toolName: action.toolName,
						args: action.args,
						status: "running",
						queued: false,
						resultText: null,
						result: { kind: "empty" },
					},
				],
			};
		case "TOOL_UPDATE":
			return {
				...state,
				items: state.items.map((it) =>
					it.kind === "tool-call" && it.toolCallId === action.toolCallId
						? { ...it, queued: action.progress.type === "queued" }
						: it,
				),
			};
		case "TOOL_END":
			return {
				...state,
				items: state.items.map((it) => {
					if (it.kind !== "tool-call" || it.toolCallId !== action.toolCallId) return it;
					const parsed = parseToolResult(it.toolName, action.details);
					return {
						...it,
						status: action.isError ? "error" : isBusyResult(action.details) ? "warning" : "done",
						queued: false,
						resultText: action.resultText,
						result: parsed,
					};
				}),
			};
		case "STREAM_DONE": {
			const { responseTimeMs } = action;
			if (responseTimeMs === undefined || state.items.length === 0)
				return { ...state, isStreaming: false };
			const items = [...state.items];
			const last = items[items.length - 1];
			items[items.length - 1] = { ...last, responseTimeMs } as TimelineItem;
			return { ...state, isStreaming: false, items };
		}
		case "SET_ERROR":
			return { ...state, isStreaming: false, error: action.message };
		case "RESET":
			return initialChatState;
	}
}

export function joinContentText(content: unknown, separator = ""): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as unknown[])
		.filter((block): block is TextBlock => Value.Check(TextContentBlock, block))
		.map((block) => block.text)
		.join(separator);
}

export function transcriptToItems(transcript: ConversationTranscript): TimelineItem[] {
	return transcript.messages.flatMap((msg): TimelineItem[] => {
		switch (msg.role) {
			case "user":
				return [{ kind: "user-message" as const, text: joinContentText(msg.content, "") }];
			case "assistant":
				return [];
			case "toolResult": {
				const parsed = parseToolResult(msg.toolName, msg.details);
				return [
					{
						kind: "tool-call" as const,
						toolCallId: msg.toolCallId,
						toolName: msg.toolName,
						args: undefined,
						status: msg.isError ? "error" : isBusyResult(msg.details) ? "warning" : "done",
						queued: false,
						resultText: joinContentText(msg.content, "\n") || null,
						result: parsed,
					},
				];
			}
		}
	});
}
