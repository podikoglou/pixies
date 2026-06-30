import { Type } from "typebox";
import { Value } from "typebox/value";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * Permissive structural guard for the SQLite `transcript` column.
 *
 * The persisted form is pi-ai's full {@link AgentMessage}[] — including
 * metadata (`timestamp`, `usage`, `api`, `provider`, `model`, …) that the
 * client-facing `TranscriptMessageSchema` (now in `@pixies/protocol`) deliberately
 * strips via `toClientTranscriptMessage`. Validating a rehydrated row against the
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
