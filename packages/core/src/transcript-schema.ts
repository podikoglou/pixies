import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export const TranscriptContentBlockSchema = Type.Object(
	{
		type: Type.String(),
		text: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

export type TranscriptContentBlock = Static<typeof TranscriptContentBlockSchema>;

export const TranscriptUserMessageSchema = Type.Object(
	{
		role: Type.Literal("user"),
		content: Type.Union([Type.String(), Type.Array(TranscriptContentBlockSchema)]),
	},
	{ additionalProperties: false },
);

export type TranscriptUserMessage = Static<typeof TranscriptUserMessageSchema>;

export const TranscriptAssistantMessageSchema = Type.Object(
	{
		role: Type.Literal("assistant"),
		content: Type.Array(TranscriptContentBlockSchema),
		stopReason: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

export type TranscriptAssistantMessage = Static<typeof TranscriptAssistantMessageSchema>;

export const TranscriptToolResultMessageSchema = Type.Object(
	{
		role: Type.Literal("toolResult"),
		toolCallId: Type.String(),
		toolName: Type.String(),
		content: Type.Array(TranscriptContentBlockSchema),
		details: Type.Optional(Type.Unknown()),
		isError: Type.Boolean(),
	},
	{ additionalProperties: false },
);

export type TranscriptToolResultMessage = Static<typeof TranscriptToolResultMessageSchema>;

export const TranscriptMessageSchema = Type.Union([
	TranscriptUserMessageSchema,
	TranscriptAssistantMessageSchema,
	TranscriptToolResultMessageSchema,
]);

export type TranscriptMessage = Static<typeof TranscriptMessageSchema>;

export const ConversationTranscriptSchema = Type.Object({
	id: Type.String(),
	messages: Type.Array(TranscriptMessageSchema),
});

export type ConversationTranscript = Static<typeof ConversationTranscriptSchema>;

export function isConversationTranscript(value: unknown): value is ConversationTranscript {
	return Value.Check(ConversationTranscriptSchema, value);
}

/**
 * Strip internal metadata from any agent message kind (user/assistant/toolResult)
 * before returning a transcript to clients over the GET /conversations/:id route.
 *
 * Schema-driven via {@link TranscriptMessageSchema} so it stays in sync with the
 * wire contract (issue #47). Covers AssistantMessage metadata
 * (api/provider/model/usage/etc.) and the `timestamp` field present on every
 * pi-ai message. `Value.Clean` mutates its input, so we clone first — the
 * incoming object may be the agent's own internal reference (also persisted to
 * SQLite) and must not be corrupted.
 */
export function toClientTranscriptMessage(msg: AgentMessage): TranscriptMessage {
	return Value.Clean(TranscriptMessageSchema, Value.Clone(msg)) as TranscriptMessage;
}
