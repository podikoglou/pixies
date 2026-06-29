import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { isBusyResult, isTaggedError, toolResultCount, type ToolProgress } from "@pixies/core";
import type { Logger } from "@pixies/core/logging";
import { captureServerEvent, type ToolCallOutcome } from "./analytics-events.ts";
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

/**
 * Minimal TypeBox schema for the only field `recordToolEnd` reads off the raw
 * tool result. `details` itself is intentionally {@link Type.Unknown} — the
 * per-tool shape is interpreted by `isBusyResult` / `toolResultCount`, not here.
 */
const ToolResultDetailsSchema = Type.Object({ details: Type.Optional(Type.Unknown()) });

/** Narrow a `turn_end` message to its assistant-message slice. */
function isAssistantTurn(message: AgentMessage): message is AgentMessage & AssistantTurnMessage {
	return message.role === "assistant";
}

/**
 * Derive the per-tool `outcome` from the error flag, the busy marker, and the
 * pre-computed result count.
 *
 * - `isError` → `error` (the tool threw or was blocked; the `_tag` is not
 *   recoverable from the flattened result, so no sub-differentiation).
 * - busy marker on a success → `busy` (transient OSM overload).
 * - data-fetch tool with zero features → `empty` (the silent-empty failure).
 * - else → `success`.
 */
function deriveOutcome(
	isError: boolean,
	isBusy: boolean,
	count: number | undefined,
): ToolCallOutcome {
	if (isError) return "error";
	if (isBusy) return "busy";
	if (count === 0) return "empty";
	return "success";
}

/** Ingredients for the byte-identical `error` SSE wire frame, from {@link StreamInstrumentation.fail}. */
export interface StreamErrorFrame {
	/** Error tag when the rejection is a `TaggedError`, else `undefined`. */
	tag: string | undefined;
	/** `err.message` (or stringified) — goes to the wire, NOT to analytics. */
	message: string;
	/** Safe `toJSON()` payload for a `TaggedError`, else `undefined`. Wire-only. */
	details: object | undefined;
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
 *    with the `turn_index` counter + the turn-start timestamp it pairs with;
 *  - the `tool call` capture (per-tool outcome, latency, queue-wait, result
 *    count) via {@link recordToolEnd}, with the per-`toolCallId` start/queue
 *    tracking that {@link recordToolStart} / {@link recordToolProgress} feed.
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
	private startTime = Date.now();
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
	// Per-tool-execution tracking, keyed by `toolCallId`. Each entry stamps the
	// `tool_execution_start` time and (optionally) the rate-limiter queue-wait
	// window from `tool_execution_update` progress. Cleaned up at
	// `tool_execution_end` ({@link recordToolEnd}).
	private toolStarts = new Map<string, { startedAt: number; queuedAt?: number }>();

	constructor(
		private distinctId: string,
		private posthog: PostHogAnalyticsClient | undefined,
		private logger: Logger,
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
	 * Stamp a tool-execution start (`tool_execution_start`). Pairs with the
	 * matching {@link recordToolEnd} to anchor `duration_ms`. Keyed by
	 * `toolCallId` so concurrent tool calls don't collide.
	 */
	recordToolStart(toolCallId: string): void {
		this.toolStarts.set(toolCallId, { startedAt: Date.now() });
	}

	/**
	 * Record a `tool_execution_update` progress signal (`queued` → `running`).
	 * `queued` stamps the queue-entry time; `running` resolves `queue_wait_ms`
	 * from that stamp. Tools that never queue (no rate limiter) never call this.
	 */
	recordToolProgress(toolCallId: string, progress: ToolProgress): void {
		const entry = this.toolStarts.get(toolCallId);
		if (!entry) return;
		if (progress.type === "queued") entry.queuedAt = Date.now();
		if (progress.type === "running" && entry.queuedAt !== undefined) {
			// queue_wait_ms is read at recordToolEnd; keep the resolved value.
			entry.queuedAt = Date.now() - entry.queuedAt;
		}
	}

	/**
	 * Capture the `tool call` event at `tool_execution_end` — one structured
	 * event per tool execution — then clean up the tracking entry. Derives the
	 * `outcome` from `isError` + the busy marker + the result-count check.
	 * Carries tool name, latency, optional queue-wait, optional result count.
	 *
	 * Privacy: every property is coarse metadata (ids, enums, counts,
	 * durations). Tool ARGUMENTS and result CONTENT are never captured — only
	 * the tool id, the derived outcome enum, and (for data-fetch tools) a
	 * feature count. The error `_tag` is NOT available: pi-agent-core flattens
	 * thrown errors before they reach the stream loop (see
	 * {@link ToolCallOutcome}).
	 *
	 * @param toolCallId Identifies the tracking entry (cleaned up after).
	 * @param toolName   The tool id (`tool_execution_end.toolName`).
	 * @param result     The raw tool result — only `result.details` is read
	 *                   (for the busy check + feature count). Content text and
	 *                   error messages are never touched.
	 * @param isError    `tool_execution_end.isError`.
	 */
	recordToolEnd(toolCallId: string, toolName: string, result: unknown, isError: boolean): void {
		const entry = this.toolStarts.get(toolCallId);
		const startedAt = entry?.startedAt ?? this.startTime;
		this.toolStarts.delete(toolCallId);
		// Only `result.details` is read — never `result.content` (carries text
		// / error messages that embed place names for OSM errors). Parsed through
		// {@link ToolResultDetailsSchema} so a non-object result collapses to
		// `undefined` details instead of an `as`-cast assuming the shape.
		const details = Value.Check(ToolResultDetailsSchema, result) ? result.details : undefined;
		const isBusy = isBusyResult(details);
		const count = toolResultCount(toolName, details);
		const outcome = deriveOutcome(isError, isBusy, count);
		captureServerEvent(this.posthog, this.distinctId, "tool call", {
			tool_name: toolName,
			outcome,
			duration_ms: Date.now() - startedAt,
			...(entry?.queuedAt !== undefined ? { queue_wait_ms: entry.queuedAt } : {}),
			...(count !== undefined && !isError && !isBusy ? { result_count: count } : {}),
		});
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
		// better-result's `AnyTaggedError` type omits `toJSON`, but every
		// TaggedError instance carries a safe `toJSON()` serializer — verify the
		// capability at runtime (`in` + `typeof`) rather than asserting the shape.
		// TypeBox can't express this: `toJSON` is a method, not data.
		const details =
			isTaggedError(err) && "toJSON" in err && typeof err.toJSON === "function"
				? err.toJSON()
				: undefined;
		return { tag, message, details };
	}
}
