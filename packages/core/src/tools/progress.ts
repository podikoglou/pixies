import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

/**
 * Tool-progress signals emitted during execution, before the final result.
 *
 * Carried through `onUpdate({ details })` and surfaced on the SSE
 * `tool_execution_update` event. Separate from each tool's final-result
 * `details` shape, which travels on `tool_execution_end`.
 *
 * New progress signals (retry-backoff, partial row counts, etc.) extend this
 * union additively.
 */
export const ToolProgressSchema = Type.Union([
	Type.Object({ type: Type.Literal("queued") }),
	Type.Object({ type: Type.Literal("running") }),
]);

export type ToolProgress = Static<typeof ToolProgressSchema>;

/**
 * Runtime guard narrowing an unknown value (e.g. an SSE `details` payload) to
 * {@link ToolProgress}. Pure — exercisable without a terminal or HTTP.
 */
export function isToolProgress(value: unknown): value is ToolProgress {
	return Value.Check(ToolProgressSchema, value);
}
