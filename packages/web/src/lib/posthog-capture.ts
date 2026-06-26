import type { PostHog } from "posthog-js";
import { parseToolResult } from "@pixies/core";

/**
 * Forward a caught React render error to PostHog Error Tracking.
 *
 * `usePostHog()` returns `undefined` at runtime when telemetry is off (no
 * `VITE_POSTHOG_KEY`, so no `PostHogProvider` above us), even though its type
 * claims `PostHog`. Treat the client as optional and no-op when absent so the
 * error boundary never throws while handling an error.
 *
 * The React `componentStack` is attached so Error Tracking shows the component
 * tree alongside the JS stack — code paths only, never query text or DOM data
 * (see docs/posthog-privacy.md).
 */
export function captureReactError(
	client: PostHog | undefined,
	error: unknown,
	componentStack: string,
): void {
	if (!client) return;
	client.captureException(error, { componentStack });
}

/** Feature-count bucket for the `tool_empty` event. `"0"` is the empty outcome. */
export type ResultCountBucket = "0" | "1–5" | "6+";

/**
 * Data-fetch tools whose empty / zero-result outcome is a product signal.
 * `display_map` is excluded: it is a UI tool whose emptiness is already
 * observed via the `map_opened`/`marker_count` event, and its
 * `details.data.markers` is empty for `queryRef` maps so it would misclassify.
 */
export const DATA_FETCH_TOOLS = ["query_osm", "geocode", "reverse_geocode"] as const;

/**
 * Compute the `result_count_bucket` for a successful data-fetch tool call, or
 * `undefined` when no `tool_empty` event should fire.
 *
 * Mirrors the existing `tool_error` shape but for the success path: a places
 * app's defining failure is the *silent* empty success (200 OK, zero features).
 * The empty-RATE is the headline metric (`count(bucket="0") / count(tool_empty)`),
 * so this fires on EVERY success and buckets the feature count rather than only
 * firing on empty (which would leave no denominator).
 *
 * Returns `undefined` (don't fire) when:
 * - `toolName` is not a data-fetch tool (e.g. `display_map`, unknown tools); and
 * - `details.busy === true` — the OSM-busy soft-failure is a SUCCESS
 *   (`isError: false`) that signals a transient server issue, not a genuine
 *   zero-feature outcome, and would pollute the empty-rate (mirrors the busy
 *   detection in `chat-reducer.ts`).
 *
 * Count is derived from the canonical `parseToolResult` parser (reused from
 * `@pixies/core` so it can never drift from the tool's own `details` shape).
 *
 * Carries only the tool id and a count bucket — never query text, place names,
 * or coordinates (see docs/posthog-privacy.md).
 */
export function toolResultCountBucket(
	toolName: string,
	details: unknown,
): ResultCountBucket | undefined {
	if (!(DATA_FETCH_TOOLS as readonly string[]).includes(toolName)) return undefined;
	if ((details as Record<string, unknown> | undefined)?.busy === true) return undefined;

	const parsed = parseToolResult(toolName, details);
	let count: number;
	switch (parsed.kind) {
		case "query_osm":
		case "geocode":
			count = parsed.entries.length;
			break;
		case "reverse_geocode":
			count = 1;
			break;
		default:
			// `empty` (parse failure / no result) and any other kind → 0.
			count = 0;
	}
	if (count === 0) return "0";
	if (count <= 5) return "1–5";
	return "6+";
}

/** Event → props mapping for `captureEvent`. */
export type EventProps = {
	message_sent: { is_new_conversation: boolean };
	map_opened: { marker_count: number };
	tool_error: { tool_name: string };
	tool_empty: { tool_name: string; result_count_bucket: ResultCountBucket };
};

/**
 * Fire a product-analytics event, no-oping when telemetry is off.
 *
 * Each event carries only booleans, counts, or internal tool identifiers —
 * never the query text, place names, or coordinates (see docs/posthog-privacy.md).
 */
export function captureEvent<E extends keyof EventProps>(
	client: PostHog | undefined,
	event: E,
	props: EventProps[E],
): void {
	if (!client) return;
	client.capture(event as string, props);
}
