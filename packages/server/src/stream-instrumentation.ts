import { isTaggedError } from "@pixies/core";
import type { Logger } from "@pixies/core/logging";
import { captureServerEvent } from "./analytics-events.ts";
import type { PostHogAnalyticsClient } from "./posthog.ts";

/** Ingredients for the byte-identical `error` SSE wire frame, from {@link StreamInstrumentation.fail}. */
export interface StreamErrorFrame {
	/** Error tag when the rejection is a `TaggedError`, else `undefined`. */
	tag: string | undefined;
	/** `err.message` (or stringified) — goes to the wire, NOT to analytics. */
	message: string;
	/** Safe `toJSON()` payload for a `TaggedError`, else `undefined`. Wire-only. */
	details: Record<string, unknown> | undefined;
}

/**
 * Instrumentation seam for ONE agent-stream response.
 *
 * `pipeAgentStream` owns ONLY the HTTP concerns: building the `SseWriter`,
 * translating agent events to SSE, writing the terminal `done`/`error` wire
 * frame, and forwarding client disconnect to `ConversationStore.abort`. This
 * class owns every NON-HTTP concern that previously leaked into that function:
 *
 *  - TTFT measurement (`firstTokenMs`) + the `agent stream first token` event;
 *  - the first-output timestamp (`firstOutputAt`) that drives `had_output`;
 *  - the `running → completed | aborted` lifecycle machine that gates the
 *    `agent stream done` (success) vs `agent stream disconnect` (client went
 *    away) events so the impossible "completed && aborted" can't be
 *    represented, and a cancel after completion can't double-count;
 *  - the `agent stream error` capture, which ships the error TAG ONLY (see
 *    {@link fail}).
 *
 * Lifecycle invariants (pinned by `pipe-agent-stream.test.ts`):
 *  - a completed stream never emits `agent stream disconnect`;
 *  - an aborted stream never emits `agent stream done`;
 *  - `first token` still fires mid-stream for a stream later aborted — that is
 *    why TTFT is captured mid-stream, not at `done` (measuring only at `done`
 *    would re-create the survivor-bias this is about).
 *
 * Extracted as a recorder OBJECT (not a higher-order wrapper tapping the event
 * stream) so the HTTP loop stays readable and the timing/analytics are
 * unit-testable in isolation without an SSE round-trip. The wrapper
 * alternative was rejected: it would entangle with the SSE translation loop and
 * the raw-event TTFT measurement that must happen BEFORE wire translation.
 */
export class StreamInstrumentation {
	private readonly startTime = Date.now();
	// `running` → `completed` (wrote `done`) or `aborted` (client went away).
	// Modelled as one state, not separate booleans, so the impossible
	// "completed && aborted" can't be represented.
	private state: "running" | "completed" | "aborted" = "running";
	// First user-facing output timestamp. Assistant text SSE events are
	// deliberately suppressed on the wire (see `translateAgentEvent`), so the
	// earliest sign of life is the first `tool_execution_start` frame — that is
	// what `had_output` reports.
	private firstOutputAt: number | undefined;
	// TTFT: ms from stream start to the LLM's first user-facing TEXT token. The
	// raw agent event is seen in the loop BEFORE translation, so this is
	// measurable even though assistant text is suppressed on the wire.
	// `thinking_*` variants are excluded (internal reasoning), but their elapsed
	// time is still folded into `duration_ms` / `ttft_ms` since both are
	// measured from `startTime`.
	private firstTokenMs: number | undefined;

	constructor(
		private readonly distinctId: string,
		private readonly posthog: PostHogAnalyticsClient | undefined,
		private readonly logger: Logger,
	) {}

	/**
	 * Record TTFT on the first user-facing TEXT token. Idempotent: the loop
	 * calls this for every `message_update`/`text_delta` raw event, but only
	 * the FIRST fires `agent stream first token`. Called BEFORE wire
	 * translation (assistant text is suppressed on the wire, so this is the
	 * only chance to measure TTFT) and mid-stream so a stream later aborted
	 * still contributes a measurement.
	 */
	recordFirstTextToken(): void {
		if (this.firstTokenMs !== undefined) return;
		this.firstTokenMs = Date.now() - this.startTime;
		captureServerEvent(this.posthog, this.distinctId, "agent stream first token", {
			ttft_ms: this.firstTokenMs,
		});
	}

	/**
	 * Stamp the first user-facing output (first `tool_execution_start` SSE
	 * frame). Idempotent. Drives the `had_output` boolean on a later
	 * {@link disconnect}.
	 */
	recordFirstOutput(): void {
		if (this.firstOutputAt === undefined) this.firstOutputAt = Date.now();
	}

	/**
	 * Normal stream end. Captures `agent stream done` (only if still running),
	 * transitions to `completed`, and returns the elapsed duration so
	 * `pipeAgentStream` writes the byte-identical `done` wire frame with the
	 * SAME value (duration is computed once here, not twice). Returns
	 * `undefined` when the stream was already aborted — no `done` capture fires
	 * and no `done` wire frame is wanted (a client cancel has already torn down
	 * the response body, so the write would be a silent no-op anyway).
	 */
	complete(): number | undefined {
		if (this.state !== "running") return undefined;
		const durationMs = Date.now() - this.startTime;
		captureServerEvent(this.posthog, this.distinctId, "agent stream done", {
			duration_ms: durationMs,
			...(this.firstTokenMs !== undefined ? { ttft_ms: this.firstTokenMs } : {}),
		});
		this.state = "completed";
		return durationMs;
	}

	/**
	 * Client went away. Captures `agent stream disconnect` only while running
	 * (a cancel after completion is a late close, not a disconnect) and
	 * transitions to `aborted`. This lambda is the ONLY server-side path from
	 * "client went away" to a disconnect capture — eviction/sweep/delete call
	 * `store.abort` directly, not through here. The server can't tell a user
	 * Stop from a passive disconnect (both cancel the stream), so this fires
	 * for both; the client `user_stop` event is the active-rejection subset on
	 * a deliberately-unlinked distinctId.
	 */
	disconnect(): void {
		if (this.state !== "running") return;
		this.state = "aborted";
		captureServerEvent(this.posthog, this.distinctId, "agent stream disconnect", {
			elapsed_ms: Date.now() - this.startTime,
			had_output: this.firstOutputAt !== undefined,
		});
	}

	/**
	 * Stream rejected. Logs the rejection (conversationId + err) and captures
	 * `agent stream error`, then returns the wire-frame ingredients so
	 * `pipeAgentStream` writes the byte-identical `error` SSE frame.
	 *
	 * Privacy: captures the error TAG ONLY — never `err.message` or the Error
	 * object. Overpass/Nominatim errors embed OSM HTTP bodies and the searched
	 * place name in `.message`. Subject to change only if we later add a
	 * sanitised message. The returned `message`/`details` go to the WIRE frame
	 * (the client), NOT to analytics.
	 */
	fail(err: unknown): StreamErrorFrame {
		const loggedErr = err instanceof Error ? err : new Error(String(err));
		this.logger.error("agent stream error", { conversationId: this.distinctId, err: loggedErr });
		const tag = isTaggedError(err) ? err._tag : undefined;
		captureServerEvent(
			this.posthog,
			this.distinctId,
			"agent stream error",
			tag !== undefined ? { error_tag: tag } : {},
		);
		const message = err instanceof Error ? err.message : String(err);
		// `isTaggedError` narrows to the loose `AnyTaggedError` shape (which
		// omits `toJSON` from its type), but every TaggedError instance
		// carries a safe `toJSON()` serializer at runtime.
		const details = isTaggedError(err)
			? ((err as unknown as { toJSON(): object }).toJSON() as Record<string, unknown>)
			: undefined;
		return { tag, message, details };
	}
}
