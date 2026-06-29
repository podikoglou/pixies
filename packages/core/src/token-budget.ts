import { Type } from "typebox";
import { Value } from "typebox/value";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { BudgetExceededError } from "./errors.ts";

/**
 * Permissive shape of a persisted assistant message's `usage` field. A LIVE
 * assistant message declares `usage: Usage` (with `totalTokens: number`) as
 * required, but the messages summed here are persisted, untrusted data
 * (ADR-0008) that may lack it — every field is optional so a row written by an
 * older binary still checks, and the count path signals the gap via
 * `missingUsage` instead of mis-typing the agent state.
 */
const AssistantUsageSchema = Type.Object({
	usage: Type.Optional(Type.Object({ totalTokens: Type.Optional(Type.Number()) })),
});

/**
 * Token-budget enforcement for conversations — the single typed home for the
 * feature previously smeared across three sites in `ConversationStore`
 * (a `computeTokensUsed` free function reading `(msg as any).usage`, an inline
 * `tokensUsed >= budget` check inside `streamPrompt`, and the
 * {@link BudgetExceededError} tagged result).
 *
 * Two pure operations behind one boundary:
 * 1. {@link countTranscriptTokens} — count tokens consumed by a transcript.
 * 2. {@link budgetExceeded} — decide whether a count is over budget.
 *
 * The module is intentionally pure (no logger): `ConversationStore` owns the
 * policy of what to do with a result (warn on rehydrate, reject on stream).
 *
 * See ADR-0008 for why persisted transcript rows are treated as untrusted.
 */

/**
 * Result of counting tokens across a transcript.
 *
 * `total` is the sum of every assistant message's `usage.totalTokens`.
 * `missingUsage` counts assistant messages whose `usage` was missing or
 * non-numeric at runtime — such messages contribute 0 tokens to `total` (so
 * the budget is undercounted), but the count lets the caller surface the
 * undercount instead of staying silent. Persisted rows rehydrated across
 * versions may lack `usage` (ADR-0008: a SQLite value written by an older
 * binary flows back in as `AgentMessage[]` with no runtime validation of the
 * nested field); a live assistant message from pi-ai always carries it.
 */
export interface TranscriptTokenCount {
	total: number;
	missingUsage: number;
}

/**
 * Count tokens consumed by a transcript.
 *
 * Narrows on `role === "assistant"` (the `AgentMessage` union's discriminant)
 * and reads `usage.totalTokens` through {@link AssistantUsageSchema}. A LIVE
 * assistant message declares `usage: Usage` (with `totalTokens: number`) as
 * required, so typed narrowing alone would suffice for in-memory data — but
 * the messages summed here are `conv.agent.state.messages`, which after
 * rehydration is **persisted, untrusted** data (ADR-0008): an assistant row
 * written by an older binary may lack `usage` entirely. Validating it with
 * `Value.Check` against a permissive schema (every field optional) is the
 * type-safe way to honor that contract — a missing/`undefined`/non-number
 * field becomes a typed branch (counted in `missingUsage`) instead of a
 * runtime hole — while keeping the exact same arithmetic (a usage-less
 * message counts as 0).
 *
 * Non-assistant messages (user, toolResult) carry no usage and are skipped.
 */
export function countTranscriptTokens(messages: readonly AgentMessage[]): TranscriptTokenCount {
	let total = 0;
	let missingUsage = 0;
	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		// Persisted, untrusted data (ADR-0008): read `usage.totalTokens` through
		// the permissive {@link AssistantUsageSchema} rather than the live
		// `AgentMessage` type, so a missing/undefined field is a typed branch
		// (counted in `missingUsage`) instead of a runtime hole.
		if (!Value.Check(AssistantUsageSchema, msg)) {
			missingUsage += 1;
			continue;
		}
		const totalTokens = msg.usage?.totalTokens;
		if (typeof totalTokens === "number") {
			total += totalTokens;
		} else {
			// Undercount by design (0 tokens), but signaled via missingUsage so the
			// rehydrate path can warn once instead of silently mis-budgeting.
			missingUsage += 1;
		}
	}
	return { total, missingUsage };
}

/**
 * Decide whether a token count exceeds the budget.
 *
 * `budget <= 0` means unlimited and never exceeds. The check is
 * `used >= budget` (exactly-at-limit blocks the next turn), matching the
 * historical inline guard in `streamPrompt` which read the STORED
 * `conv.tokensUsed` rather than recounting fresh — callers preserve that by
 * passing the stored value. Returns the {@link BudgetExceededError} to
 * surface, or `undefined` when within budget.
 */
export function budgetExceeded(used: number, budget: number): BudgetExceededError | undefined {
	return budget > 0 && used >= budget ? new BudgetExceededError({ used, budget }) : undefined;
}
