/// <reference types="vite/client" />

declare module "@fontsource/geist-sans";

// The validated PostHog contract (host url format + default, key-as-off-switch)
// lives in posthog-config.ts; these declarations only type the raw env reads.
interface ImportMetaEnv {
	/** PostHog public project token. Presence opts the app into telemetry. */
	readonly VITE_POSTHOG_KEY?: string;
	/** PostHog Cloud host (e.g. https://app.posthog.com). */
	readonly VITE_POSTHOG_HOST?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
