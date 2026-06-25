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
