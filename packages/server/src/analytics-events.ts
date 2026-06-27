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
		/** `turn_end.message.stopReason` (`stop` | `length` | `toolUse` | `error` | `aborted`). */
		stop_reason: string;
		/** Per-turn latency: turn_start → turn_end (ms). */
		duration_ms: number;
		/** `turn_end.message.usage.input`. */
		input_tokens: number;
		/** `turn_end.message.usage.output`. */
		output_tokens: number;
		/** `usage.cacheRead` when the provider reports it (optional). */
		cache_read_tokens?: number;
		/** Any tool result in the turn failed (`tool_execution_end.isError`). */
		had_tool_error: boolean;
		/** Any non-error busy soft-failure (`{ busy: true }` details). */
		had_busy_result: boolean;
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
