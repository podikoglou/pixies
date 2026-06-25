import type { PostHog } from "posthog-js";

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
 * Product-analytics event for the chat send flow. Carries only whether this was
 * the opening message of a new conversation — never the query text, which may
 * hold sensitive location data (see docs/posthog-privacy.md).
 */
export function captureMessageSent(
	client: PostHog | undefined,
	props: { isNewConversation: boolean },
): void {
	if (!client) return;
	client.capture("message_sent", { is_new_conversation: props.isNewConversation });
}

/**
 * Product-analytics event fired when a map result renders with markers.
 * `markerCount` is a coarse richness signal (how many places were shown) and
 * reveals nothing about the query itself.
 */
export function captureMapOpened(
	client: PostHog | undefined,
	props: { markerCount: number },
): void {
	if (!client) return;
	client.capture("map_opened", { marker_count: props.markerCount });
}

/**
 * Product-analytics event fired when a tool call errors. Carries only the
 * internal tool identifier (e.g. `query_osm`) so we can see which data sources
 * fail — never the error message or args, which may carry place data.
 */
export function captureToolError(client: PostHog | undefined, toolName: string): void {
	if (!client) return;
	client.capture("tool_error", { tool_name: toolName });
}
