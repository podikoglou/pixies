import { TaggedError } from "better-result";
import { Type } from "typebox";
import type { Static } from "typebox";
import type { NominatimError } from "./clients/nominatim.ts";
import type { OverpassError } from "./clients/overpass.ts";

/**
 * Pixies' TaggedError hierarchy.
 *
 * Recoverable, classifiable failure modes carry a PascalCase `_tag`
 * discriminant so callers can exhaustively match via `matchError` /
 * `matchErrorPartial` (the same pattern `better-result` uses). Shared app and
 * tool errors live here; service-owned errors live with their clients and are
 * re-exported from `@pixies/core`.
 *
 * Conventions:
 * - `_tag` values are PascalCase domain tokens with no `Error` suffix
 *   (`"NominatimBusy"`, `"ConversationNotFound"`, ...).
 * - `name` is set to the `_tag` by the TaggedError base class.
 * - Computed-message classes (`BudgetExceededError`, plus service-specific
 *   classes in the clients) derive their `message` in the constructor so their
 *   text matches the historical throw strings byte-for-byte.
 * - Fail-fast / programmer-bug throws (config parsing, etc.) are intentionally
 *   NOT migrated (Phase 5 skip). `ConfigError` is defined
 *   here for completeness but unused on that path.
 *
 * See `errors.test.ts` for the per-class contract and `AGENTS.md` /
 * `docs/CONVENTIONS.md` for placement rationale.
 */

// --- Tool layer ---

/** A tool was aborted (signal aborted at entry, or an abort propagated up). */
export class ToolAbortedError extends TaggedError("ToolAborted")<{
	message: string;
	cause?: unknown;
}>() {}

/** `display_map` XOR-guard violation (both or neither of markers/queryRef). */
export class DisplayMapValidationError extends TaggedError("DisplayMapValidation")<{
	reason: "both" | "neither";
	message: string;
}>() {}

// --- Conversation store / server ---

/** `streamPrompt` targeted a conversation id that does not exist. */
export class ConversationNotFoundError extends TaggedError("ConversationNotFound")<{
	id: string;
	message: string;
}>() {}

/** `streamPrompt` hit a conversation that already has an in-flight prompt. */
export class PromptConflictError extends TaggedError("PromptConflict")<{
	id: string;
	message: string;
}>() {}

/** Conversation token budget has been exhausted. */
export class BudgetExceededError extends TaggedError("BudgetExceeded")<{
	used: number;
	budget: number;
	message: string;
}>() {
	constructor(args: { used: number; budget: number }) {
		super({
			...args,
			message: `conversation token budget (${args.budget}) exceeded: used ${args.used}`,
		});
	}
}

// --- HTTP request parsing ---

/** Request body was not valid JSON. */
export class InvalidJsonError extends TaggedError("InvalidJson")<{
	message: string;
}>() {}

/** Request body failed schema validation. */
export class ValidationError extends TaggedError("Validation")<{
	message: string;
}>() {}

// --- Config ---
// Exported for completeness; the config-time path still throws raw (Phase 5 skip).

/** Configuration error. Currently unused on the fail-fast config path. */
export class ConfigError extends TaggedError("Config")<{
	message: string;
	cause?: unknown;
}>() {}

// --- Web transcript shape ---

/** Web client received a transcript that failed schema validation. */
export class InvalidTranscriptError extends TaggedError("InvalidTranscript")<{
	message: string;
}>() {}

// --- Canonical unions ---

/** Union of all errors `ConversationStore.streamPrompt` can return. */
export type StreamPromptError =
	| ConversationNotFoundError
	| PromptConflictError
	| BudgetExceededError;

/** Union of every Pixies TaggedError. */
export type PixiesError =
	| NominatimError
	| OverpassError
	| DisplayMapValidationError
	| StreamPromptError
	| InvalidJsonError
	| ValidationError
	| ConfigError
	| InvalidTranscriptError;

/** Discriminant string for any {@link PixiesError}. */
export type PixiesErrorTag = PixiesError["_tag"];

/**
 * TypeBox mirror of {@link PixiesErrorTag} — the closed set of `_tag` string
 * literals carried by the SSE `error` event's `errorTag` field. The web client
 * parses the raw `string` off the wire through this schema (ADR-0002: TypeBox
 * + `Value.Check` is the SSE boundary primitive), so unknown tags
 * deterministically become `undefined` at the read boundary instead of being
 * `as`-cast and leaning on a downstream `default` arm.
 *
 * The literals MUST stay in sync with the `TaggedError(...)` classes that make
 * up {@link PixiesError}. The `_errorTagSchemaInSync` const below is a
 * compile-time drift guard — adding a TaggedError without updating this schema
 * (or vice versa) fails typecheck.
 */
export const PixiesErrorTagSchema = Type.Union([
	Type.Literal("NominatimBusy"),
	Type.Literal("NominatimParse"),
	Type.Literal("NominatimHttp"),
	Type.Literal("OverpassBusy"),
	Type.Literal("OverpassHttp"),
	Type.Literal("OverpassParse"),
	Type.Literal("OverpassRemark"),
	Type.Literal("ToolAborted"),
	Type.Literal("DisplayMapValidation"),
	Type.Literal("ConversationNotFound"),
	Type.Literal("PromptConflict"),
	Type.Literal("BudgetExceeded"),
	Type.Literal("InvalidJson"),
	Type.Literal("Validation"),
	Type.Literal("Config"),
	Type.Literal("InvalidTranscript"),
]);

// Compile-time drift guard: the schema's literal set must equal PixiesError["_tag"]
// exactly. If a TaggedError is added/removed without updating the schema (or vice
// versa), the conditional resolves to a string-literal error hint instead of
// `true`, and the `= true` assignment below fails typecheck with that hint.
const _errorTagSchemaInSync: [Static<typeof PixiesErrorTagSchema>] extends [PixiesError["_tag"]]
	? [PixiesError["_tag"]] extends [Static<typeof PixiesErrorTagSchema>]
		? true
		: "schema_missing_tags"
	: "schema_has_extra_tags" = true;
