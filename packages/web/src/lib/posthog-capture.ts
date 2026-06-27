import type { PostHog } from "posthog-js";
import { toolResultCount } from "@pixies/core";

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

/**
 * Re-exported from `@pixies/core` so the web `tool_empty` event and the server
 * `tool call` event share a single count-derivation path. The function returns
 * `undefined` (don't fire `tool_empty`) for non-data-fetch tools and busy
 * soft-failures; a raw int otherwise, so the empty-RATE headline metric
 * (`count(result_count=0) / count(tool_empty)`) has a denominator.
 */
export { toolResultCount };

/** Event → props mapping for `captureEvent`. */
export type EventProps = {
	message_sent: { is_new_conversation: boolean };
	map_opened: { marker_count: number };
	tool_error: { tool_name: string };
	user_stop: { had_output: boolean };
	tool_empty: { tool_name: string; result_count: number };
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
