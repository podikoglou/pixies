import { useMemo } from "react";
import { usePostHog } from "@posthog/react";
import type { PostHog } from "posthog-js";
import { captureEvent, captureReactError } from "@/lib/posthog-capture";

/**
 * Product-analytics + error-tracking surface for components.
 *
 * `usePostHog()` is typed non-nullable by `@posthog/react` but returns
 * `undefined` at runtime when telemetry is off (no `VITE_POSTHOG_KEY`, so no
 * `PostHogProvider` mounted). That cast lives here once, so call sites stay
 * clean: every method no-ops when telemetry is disabled and never throws.
 *
 * Methods take domain values and own the snake_case wire format — only
 * booleans, counts, and internal tool identifiers ever leave the app (see
 * docs/posthog-privacy.md).
 */
export interface Analytics {
	messageSent(isNewConversation: boolean): void;
	mapOpened(markerCount: number): void;
	toolError(toolName: string): void;
	captureError(error: unknown, componentStack: string): void;
}

export function useAnalytics(): Analytics {
	const posthog = usePostHog() as PostHog | undefined;
	return useMemo<Analytics>(
		() => ({
			messageSent: (isNewConversation) =>
				captureEvent(posthog, "message_sent", { is_new_conversation: isNewConversation }),
			mapOpened: (markerCount) =>
				captureEvent(posthog, "map_opened", { marker_count: markerCount }),
			toolError: (toolName) => captureEvent(posthog, "tool_error", { tool_name: toolName }),
			captureError: (error, componentStack) => captureReactError(posthog, error, componentStack),
		}),
		[posthog],
	);
}
