import type { SSEEvent } from "@pixies/core";
import { isConversationTranscript, type ConversationTranscript } from "@pixies/core";
import { buildApiError, streamSSE } from "../sse/client.ts";

export type {
	ConversationTranscript,
	TranscriptContentBlock,
	TranscriptUserMessage,
	TranscriptAssistantMessage,
	TranscriptToolResultMessage,
	TranscriptMessage,
} from "@pixies/core";

export async function getConversation(id: string): Promise<ConversationTranscript> {
	const res = await fetch(`/conversations/${encodeURIComponent(id)}`);
	if (!res.ok) throw await buildApiError(res);
	const data = await res.json();
	if (!isConversationTranscript(data)) throw new Error("invalid transcript");
	return data;
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
