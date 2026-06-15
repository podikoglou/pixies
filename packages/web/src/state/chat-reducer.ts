import type { ConversationTranscript } from "../api/conversations.ts";
import { parseToolResult, summarizeResult, type ToolProgress, type ToolResult } from "@pixies/core";

export type TimelineItem =
	| { kind: "user-message"; text: string }
	| { kind: "assistant-message"; text: string }
	| {
			kind: "tool-call";
			toolCallId: string;
			toolName: string;
			args: unknown;
			status: "running" | "done" | "error";
			queued: boolean;
			resultText: string | null;
			result: ToolResult;
			summary: string | null;
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
	| { type: "MESSAGE_END"; text: string }
	| { type: "TOOL_START"; toolCallId: string; toolName: string; args: unknown }
	| { type: "TOOL_UPDATE"; toolCallId: string; progress: ToolProgress }
	| {
			type: "TOOL_END";
			toolCallId: string;
			isError: boolean;
			resultText: string | null;
			details: unknown;
	  }
	| { type: "STREAM_DONE" }
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
		case "MESSAGE_END": {
			const text = action.text.length > 0 ? action.text : state.streamingText;
			if (text.length === 0) return { ...state, streamingText: "" };
			return {
				...state,
				items: [...state.items, { kind: "assistant-message", text }],
				streamingText: "",
			};
		}
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
						summary: null,
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
						status: action.isError ? "error" : "done",
						queued: false,
						resultText: action.resultText,
						result: parsed,
						summary: summarizeResult(parsed),
					};
				}),
			};
		case "STREAM_DONE":
			return { ...state, isStreaming: false };
		case "SET_ERROR":
			return { ...state, isStreaming: false, error: action.message };
		case "RESET":
			return initialChatState;
	}
}

export function joinContentText(content: unknown, separator = ""): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (
			block !== null &&
			typeof block === "object" &&
			(block as { type?: unknown }).type === "text" &&
			typeof (block as { text?: unknown }).text === "string"
		) {
			parts.push((block as { text: string }).text);
		}
	}
	return parts.join(separator);
}

export function transcriptToItems(transcript: ConversationTranscript): TimelineItem[] {
	const items: TimelineItem[] = [];
	for (const msg of transcript.messages) {
		switch (msg.role) {
			case "user":
				items.push({ kind: "user-message", text: joinContentText(msg.content, "") });
				break;
			case "assistant": {
				const text = joinContentText(msg.content, "");
				if (text.length > 0) items.push({ kind: "assistant-message", text });
				break;
			}
			case "toolResult": {
				const parsed = parseToolResult(msg.toolName, msg.details);
				items.push({
					kind: "tool-call",
					toolCallId: msg.toolCallId,
					toolName: msg.toolName,
					args: undefined,
					status: msg.isError ? "error" : "done",
					queued: false,
					resultText: joinContentText(msg.content, "\n") || null,
					result: parsed,
					summary: summarizeResult(parsed),
				});
				break;
			}
		}
	}
	return items;
}
