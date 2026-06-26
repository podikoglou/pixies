import { PostHog } from "posthog-node";

/**
 * Minimal analytics surface we consume from `posthog-node`.
 *
 * Narrowed to the two methods we use (`capture` + `shutdown`) so the rest of
 * the server depends on this seam, not the full `posthog-node` client. This is
 * also the injection point for tests (`StartServerOptions.posthog`).
 */
export interface PostHogAnalyticsClient {
	capture(msg: { distinctId: string; event: string; properties?: Record<string, unknown> }): void;
	shutdown(): Promise<void>;
}

/**
 * Wrap a real `posthog-node` client behind {@link PostHogAnalyticsClient}.
 *
 * NB: `posthog-node`'s `.d.ts` declares `shutdown(): void`, but the runtime
 * implementation is `async` and returns the queued-event flush promise. Routing
 * it through `Promise.resolve` both satisfies our `Promise<void>` contract AND
 * genuinely awaits the flush on graceful shutdown. `host` is always defined
 * here (`config.posthogHost` has a default).
 *
 * `$process_person_profile: false` is intentionally NOT set here — that is a
 * per-event decision centralised in {@link captureAnalytics}.
 */
export function createPostHogAnalyticsClient(opts: {
	apiKey: string;
	host: string;
}): PostHogAnalyticsClient {
	const client = new PostHog(opts.apiKey, { host: opts.host });
	return {
		capture: (m) => client.capture(m),
		shutdown: () => Promise.resolve(client.shutdown()),
	};
}

/**
 * Capture an analytics event, or no-op when no client is configured.
 *
 * `client === undefined` is the off-switch: with no `PIXIES_POSTHOG_API_KEY`
 * there is no client, hence no captures and no network. Every captured event
 * carries `$process_person_profile: false` — Pixies is anonymous (no auth),
 * so we never want PostHog to materialise a Person profile per conversation/IP.
 *
 * Centralising both decisions here (no-op + `$process_person_profile: false`)
 * keeps them in one unit-testable place.
 */
export function captureAnalytics(
	client: PostHogAnalyticsClient | undefined,
	event: { distinctId: string; name: string; properties?: Record<string, unknown> },
): void {
	if (client === undefined) return;
	client.capture({
		distinctId: event.distinctId,
		event: event.name,
		properties: { $process_person_profile: false, ...event.properties },
	});
}
