import type { SSEEvent } from "@pixies/core";
import { buildApiError, streamSSE } from "../sse/client.ts";

export interface TranscriptContentBlock {
	type: string;
	text?: string;
}

export interface TranscriptUserMessage {
	role: "user";
	content: string | TranscriptContentBlock[];
}

export interface TranscriptAssistantMessage {
	role: "assistant";
	content: TranscriptContentBlock[];
	stopReason?: string;
}

export interface TranscriptToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: TranscriptContentBlock[];
	details?: unknown;
	isError: boolean;
}

export type TranscriptMessage =
	| TranscriptUserMessage
	| TranscriptAssistantMessage
	| TranscriptToolResultMessage;

export interface ConversationTranscript {
	id: string;
	messages: TranscriptMessage[];
}

export async function getConversation(id: string): Promise<ConversationTranscript> {
	const res = await fetch(`/conversations/${encodeURIComponent(id)}`);
	if (!res.ok) throw await buildApiError(res);
	return (await res.json()) as ConversationTranscript;
}

export async function deleteConversation(id: string): Promise<void> {
	const res = await fetch(`/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
	if (!res.ok && res.status !== 204) throw await buildApiError(res);
}

export function createConversationStream(
	message: string,
	signal?: AbortSignal,
): AsyncGenerator<SSEEvent> {
	return streamSSE("/conversations", { message }, signal);
}

export function sendMessageStream(
	id: string,
	message: string,
	signal?: AbortSignal,
): AsyncGenerator<SSEEvent> {
	return streamSSE(`/conversations/${encodeURIComponent(id)}/messages`, { message }, signal);
}
