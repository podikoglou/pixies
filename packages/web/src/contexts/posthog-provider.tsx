import { type ReactNode } from "react";
import { PostHogProvider } from "@posthog/react";

/**
 * PostHog public project token (NOT the secret server API key) and Cloud host.
 * Off by default: when `VITE_POSTHOG_KEY` is unset the provider is skipped
 * entirely and no telemetry leaves the browser. See docs/posthog-privacy.md.
 *
 * The capture features below are intentionally OFF in this foundation and are
 * flipped on by their own issues:
 *   - autocapture         → #173 (product analytics)
 *   - capture_exceptions  → #172 (client error monitoring)
 *   - session replay      → #175 (session replay)
 */
const POSTHOG_KEY = import.meta.env.VITE_POSTHOG_KEY;
const POSTHOG_HOST = import.meta.env.VITE_POSTHOG_HOST;

const isEnabled = typeof POSTHOG_KEY === "string" && POSTHOG_KEY.length > 0;

/**
 * Wraps the app in PostHogProvider when the operator has opted in via env, and
 * renders children untouched otherwise. Pixies has no auth, so events stay
 * anonymous (no `identify` calls); see docs/posthog-privacy.md.
 */
export function OptionalPostHogProvider({ children }: { children: ReactNode }) {
	if (!isEnabled) return <>{children}</>;
	return (
		<PostHogProvider
			apiKey={POSTHOG_KEY}
			options={{
				api_host: POSTHOG_HOST,
				autocapture: false,
				capture_exceptions: false,
				disable_session_recording: true,
				debug: import.meta.env.DEV,
			}}
		>
			{children}
		</PostHogProvider>
	);
}
