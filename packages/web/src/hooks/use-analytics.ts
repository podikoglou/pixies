import { useMemo } from "react";
import { usePostHog } from "@posthog/react";
import type { PostHog } from "posthog-js";
import { type EventProps, captureEvent, captureReactError } from "@/lib/posthog-capture";

/**
 * PostHog surface for components, owning the optional-client cast once so call
 * sites never import posthog. `usePostHog()` is typed non-nullable by
 * `@posthog/react` but returns `undefined` at runtime when telemetry is off (no
 * `VITE_POSTHOG_KEY`, so no `PostHogProvider` mounted); every method no-ops in
 * that case. See docs/posthog-privacy.md for what each event may carry.
 */
export interface Analytics {
	capture<E extends keyof EventProps>(event: E, props: EventProps[E]): void;
	captureError(error: unknown, componentStack: string): void;
}

export function useAnalytics(): Analytics {
	const posthog = usePostHog() as PostHog | undefined;
	return useMemo<Analytics>(
		() => ({
			capture<E extends keyof EventProps>(event: E, props: EventProps[E]) {
				captureEvent(posthog, event, props);
			},
			captureError(error: unknown, componentStack: string) {
				captureReactError(posthog, error, componentStack);
			},
		}),
		[posthog],
	);
}
