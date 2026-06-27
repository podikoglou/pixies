import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { isBusyResult, isTaggedError } from "@pixies/core";
import type { Logger } from "@pixies/core/logging";
import { captureServerEvent } from "./analytics-events.ts";
import type { PostHogAnalyticsClient } from "./posthog.ts";

/**
 * Structural slice of an `AssistantMessage` read by the `agent turn` capture.
 *
 * `turn_end.message` is typed as the broad `AgentMessage` (a server-side
 * re-export of the real `AssistantMessage` would drag a transitive dep in, so
 * this names just the fields the capture touches). The {@link isAssistantTurn}
 * guard narrows to it.
 */
interface AssistantTurnMessage {
	role: "assistant";
	stopReason: string;
	usage: { input: number; output: number; cacheRead?: number };
}

/** Structural slice of a `turn_end` tool result: id + error flag + details. */
interface TurnToolResult {
	toolName: string;
	isError: boolean;
	details?: unknown;
}

/** Narrow a `turn_end` message to its assistant-message slice. */
function isAssistantTurn(message: AgentMessage): message is AgentMessage & AssistantTurnMessage {
	return (message as { role?: unknown }).role === "assistant";
}

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
 *    {@link fail});
 *  - the `agent turn` capture (per-turn tool count + tool ids, stop reason,
 *    duration, token usage, soft-failure flags) via {@link recordTurnEnd},
 *    with the `turn_index` counter + the turn-start timestamp it pairs with.
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
	// Per-turn tracking. `turnIndex` is the counter reported on each
	// `agent turn` capture (0-based, advanced after each {@link recordTurnEnd}).
	// `turnStartAt` anchors the turn's `duration_ms`. The agent loop emits
	// `turn_start` only for turns AFTER the first, so this initialises to the
	// stream start — turn 0 measures from there, later turns from their
	// `turn_start` ({@link recordTurnStart}).
	private turnIndex = 0;
	private turnStartAt: number = this.startTime;

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
	 * Stamp the start of an agent turn (`turn_start` event). Pairs with the next
	 * {@link recordTurnEnd} to anchor the turn's `duration_ms`. The agent loop
	 * omits `turn_start` for the first turn, so the recorder falls back to the
	 * stream start ({@link turnStartAt}'s initial value).
	 */
	recordTurnStart(): void {
		this.turnStartAt = Date.now();
	}

	/**
	 * Capture the `agent turn` event at `turn_end` — one structured event per
	 * turn of the agent loop — then advance {@link turnIndex}. Carries the
	 * tool-call count + tool ids, stop reason, per-turn duration, token usage,
	 * and the soft-failure flags. Mirrors the existing capture seam: distinctId
	 * is the conversation id, `$process_person_profile: false` is injected
	 * centrally by `captureServerEvent`.
	 *
	 * Privacy: every property is coarse metadata (counts, ids, enums,
	 * durations). Tool ARGUMENTS are never captured (they carry place
	 * names/coords); `tool_names` ships ids only. Token usage comes straight
	 * off the assistant message's `usage`. A non-assistant `turn_end` message
	 * (the agent loop always emits the assistant message, so this shouldn't
	 * happen) is skipped, not crashed — the analytics event is best-effort.
	 *
	 * @param message     The assistant message from `turn_end` (carries
	 *                    `stopReason` + `usage`).
	 * @param toolResults The turn's tool results — `length` is the tool-call
	 *                    count; each carries `toolName` (id) + `isError` + the
	 *                    busy-marked `details`.
	 */
	recordTurnEnd(message: AgentMessage, toolResults: TurnToolResult[]): void {
		// The agent loop emits the assistant message at turn_end; guard once for
		// the structural slice rather than asserting.
		if (!isAssistantTurn(message)) return;
		// tool ids only — NEVER args (toolResults carry no args, and the args
		// live on `tool_execution_start`, which this path never reads).
		const toolNames = toolResults.map((r) => r.toolName);
		const hadToolError = toolResults.some((r) => r.isError);
		// Busy is a SUCCESS (isError: false) but a transient OSM soft-failure —
		// `isBusyResult` reads the `{ busy: true }` marker off `details`.
		const hadBusyResult = toolResults.some((r) => !r.isError && isBusyResult(r.details));
		const cacheRead = message.usage.cacheRead;
		captureServerEvent(this.posthog, this.distinctId, "agent turn", {
			turn_index: this.turnIndex,
			tool_calls: toolResults.length,
			tool_names: toolNames,
			stop_reason: message.stopReason,
			duration_ms: Date.now() - this.turnStartAt,
			input_tokens: message.usage.input,
			output_tokens: message.usage.output,
			...(typeof cacheRead === "number" ? { cache_read_tokens: cacheRead } : {}),
			had_tool_error: hadToolError,
			had_busy_result: hadBusyResult,
		});
		this.turnIndex += 1;
		// Re-anchor defensively: a later turn that never sees a `turn_start`
		// (loop variant) still measures from the prior turn_end rather than the
		// stream start.
		this.turnStartAt = Date.now();
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
