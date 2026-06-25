/// <reference types="vite/client" />

declare module "@fontsource/geist-sans";

interface ImportMetaEnv {
	/** PostHog public project token. Presence opts the app into telemetry. */
	readonly VITE_POSTHOG_KEY?: string;
	/** PostHog Cloud host (e.g. https://eu.i.posthog.com). */
	readonly VITE_POSTHOG_HOST?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
