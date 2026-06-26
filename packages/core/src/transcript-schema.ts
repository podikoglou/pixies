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

// --- Persisted (SQLite) transcript guard -------------------------------------

/**
 * Permissive structural guard for the SQLite `transcript` column.
 *
 * The persisted form is pi-ai's full {@link AgentMessage}[] — including
 * metadata (`timestamp`, `usage`, `api`, `provider`, `model`, …) that the
 * client-facing {@link TranscriptMessageSchema} deliberately strips via
 * {@link toClientTranscriptMessage}. Validating a rehydrated row against the
 * client schema would therefore reject every real production row.
 *
 * This schema is intentionally permissive (`additionalProperties: true`,
 * content unconstrained): pi-ai owns the message shape and may extend it across
 * versions; the read boundary only needs to catch gross corruption (a null, a
 * string, an object without a `role`, a non-array) so a corrupted row degrades
 * to an empty conversation instead of mis-typing the in-memory agent state.
 *
 * See ADR-0002 (TypeBox for storage contracts).
 */
export const PersistedAgentMessageSchema = Type.Object(
	{
		role: Type.Union([Type.Literal("user"), Type.Literal("assistant"), Type.Literal("toolResult")]),
	},
	{ additionalProperties: true },
);

export const PersistedTranscriptSchema = Type.Array(PersistedAgentMessageSchema);

/**
 * True if `value` is structurally an `AgentMessage[]` (catches gross corruption
 * only — see {@link PersistedAgentMessageSchema}). Used at the DB read boundary
 * in `ConversationStore` to guard the `transcript` column rehydration.
 */
export function isPersistedTranscript(value: unknown): value is AgentMessage[] {
	return Value.Check(PersistedTranscriptSchema, value);
}

/**
 * Strip internal metadata from any agent message kind (user/assistant/toolResult)
 * before returning a transcript to clients over the GET /conversations/:id route.
 *
 * Schema-driven via {@link TranscriptMessageSchema} so it stays in sync with the
 * wire contract. Covers AssistantMessage metadata
 * (api/provider/model/usage/etc.) and the `timestamp` field present on every
 * pi-ai message. `Value.Clean` mutates its input, so we clone first — the
 * incoming object may be the agent's own internal reference (also persisted to
 * SQLite) and must not be corrupted.
 */
export function toClientTranscriptMessage(msg: AgentMessage): TranscriptMessage {
	return Value.Clean(TranscriptMessageSchema, Value.Clone(msg)) as TranscriptMessage;
}
