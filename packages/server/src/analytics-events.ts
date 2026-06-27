import { captureAnalytics, type PostHogAnalyticsClient } from "./posthog.ts";

/**
 * Typed contract for every server-side analytics event.
 *
 * Mirrors the web's `EventProps` (`packages/web/src/lib/posthog-capture.ts`) so
 * the server's event names + property shapes are defined in ONE place instead
 * of as inline string literals scattered across `index.ts`. The web side stays
 * as its own contract; this is the server's half.
 *
 * Names KEEP their existing (spaces-and-all) form. Renaming to match the web
 * (e.g. server `message sent` → web `message_sent`) is a deliberate NON-change:
 * the server keys events by conversation id / IP, the web by an anonymous
 * anonymous browser id, so the two sides are complementary signals, not a
 * single unified contract. Aligning them is a decision to make separately.
 *
 * Each entry's property shape is verified against its current call site in
 * `index.ts` / `stream-instrumentation.ts` — no keys invented, none renamed.
 */

/**
 * Assistant-message stop reason. Mirrors `@earendil-works/pi-ai`'s `StopReason`
 * union inline (the server depends only on `pi-agent-core`, which doesn't
 * re-export it), so an unknown value can never be reported as `stop_reason`.
 */
export type AgentStopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

/**
 * Per-tool-execution outcome. Derived from `tool_execution_end`:
 * - `error`  — `isError: true` (the tool threw or was blocked).
 * - `busy`   — non-error OSM-busy soft-failure (`{ busy: true }` details).
 * - `empty`  — non-error data-fetch tool that returned zero features.
 * - `success`— everything else (includes `display_map`, non-zero data-fetch).
 *
 * `error_tag` is NOT captured: pi-agent-core flattens thrown errors to
 * `{ content: [{ text: error.message }], details: {} }`, so the `_tag` is lost
 * before the event reaches the stream loop. The `error` outcome still
 * distinguishes the failure population.
 */
export type ToolCallOutcome = "error" | "busy" | "empty" | "success";

export type ServerAnalyticsEvent = {
	// Stream lifecycle events (captured by `StreamInstrumentation`).
	"agent stream first token": { ttft_ms: number };
	"agent stream done": { duration_ms: number; ttft_ms?: number };
	"agent stream disconnect": { elapsed_ms: number; had_output: boolean };
	"agent stream error": { error_tag?: string };
	// Per-turn agent-loop telemetry (captured by `StreamInstrumentation.recordTurnEnd`).
	"agent turn": {
		/** 0-based index of the turn within the stream (counter in the recorder). */
		turn_index: number;
		/** Tool-call count for the turn (`turn_end.toolResults.length`). */
		tool_calls: number;
		/** Tool ids only — NEVER args (args carry place names/coords). */
		tool_names: string[];
		/** `turn_end.message.stopReason` — the agent-loop stop reason (union). */
		stop_reason: AgentStopReason;
		/** Per-turn latency: turn_start → turn_end (ms). */
		duration_ms: number;
		/** `turn_end.message.usage.input`. */
		input_tokens: number;
		/** `turn_end.message.usage.output`. */
		output_tokens: number;
		/**
		 * `usage.cacheRead` when the provider populates it as a number. Typed
		 * optional because some providers omit it at runtime despite the
		 * `Usage` type declaring it required.
		 */
		cache_read_tokens?: number;
		/** Any tool result in the turn failed (`tool_execution_end.isError`). */
		had_tool_error: boolean;
		/** Any non-error busy soft-failure (`{ busy: true }` details). */
		had_busy_result: boolean;
	};
	// Per-tool-execution telemetry (captured by `StreamInstrumentation.recordToolEnd`).
	"tool call": {
		/** Tool id (`tool_execution_end.toolName`). NEVER tool args. */
		tool_name: string;
		/** Derived outcome — see {@link ToolCallOutcome}. */
		outcome: ToolCallOutcome;
		/** `tool_execution_start` → `tool_execution_end` (ms). */
		duration_ms: number;
		/**
		 * Rate-limiter queue wait: `queued` → `running` progress (ms). Omitted
		 * when the tool never queued (no rate limiter, e.g. `display_map`).
		 */
		queue_wait_ms?: number;
		/**
		 * Feature count for successful data-fetch tools (query_osm, geocode,
		 * reverse_geocode). Omitted for non-data-fetch tools and for error/busy
		 * outcomes. Derived via `toolResultCount` from `@pixies/core`.
		 */
		result_count?: number;
	};
	// Route-handler events (captured at the handler boundary in `index.ts`).
	"conversation started": { message_length: number };
	"message sent": { message_length: number };
	"conversation deleted": Record<string, never>;
	"conversation budget exceeded": { tokens_used: number; token_budget: number };
	"rate limit exceeded": { path: string };
};

/**
 * Capture a server analytics event against the typed contract, or no-op.
 *
 * A thin typed veneer over {@link captureAnalytics}: delegating (rather than
 * re-implementing) preserves both centralised decisions verbatim — the
 * undefined-client off-switch and the `$process_person_profile: false`
 * injection (Pixies is anonymous, so PostHog must never materialise a Person
 * profile per conversation/IP). Routing every server capture through here keeps
 * an untyped inline string literal from drifting off the contract.
 *
 * @param client     The analytics seam; `undefined` short-circuits (off-switch).
 * @param distinctId Conversation id or client IP (never the anonymous browser id).
 * @param event      One of {@link ServerAnalyticsEvent} — typed name + props.
 */
export function captureServerEvent<E extends keyof ServerAnalyticsEvent>(
	client: PostHogAnalyticsClient | undefined,
	distinctId: string,
	event: E,
	properties: ServerAnalyticsEvent[E],
): void {
	captureAnalytics(client, { distinctId, name: event, properties });
}
