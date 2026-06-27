import { type ReactNode } from "react";
import { PostHogProvider } from "@posthog/react";
import { posthogConfig } from "../posthog-config";

/**
 * Wraps the app in PostHogProvider when the operator has opted in via env, and
 * renders children untouched otherwise. Pixies has no auth, so events stay
 * anonymous (no `identify` calls); see docs/posthog-privacy.md.
 */
export function OptionalPostHogProvider({ children }: { children: ReactNode }) {
	if (!posthogConfig.enabled) return <>{children}</>;
	return (
		<PostHogProvider
			apiKey={posthogConfig.key}
			options={{
				api_host: posthogConfig.host,
				// Autocapture stays off — the composer's query text is sensitive
				// location data and must never be collected. Product events are sent
				// explicitly at their user-action sites instead (see posthog-capture.ts
				// and docs/posthog-privacy.md).
				autocapture: false,
				capture_exceptions: true,
				disable_session_recording: true,
				debug: import.meta.env.DEV,
			}}
		>
			{children}
		</PostHogProvider>
	);
}
