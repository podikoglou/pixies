import { Type } from "typebox";
import { Value } from "typebox/value";

/**
 * Schema for the two `VITE_POSTHOG_*` env vars Vite inlines into the SPA at
 * build time. Mirrors the server's `posthogHost` / `posthogApiKey` contract in
 * `PixiesConfigSchema` (`@pixies/core`): a url-format host with a documented
 * default, and a key whose presence is the telemetry off-switch. See
 * docs/posthog-privacy.md.
 *
 * The web host default is `https://app.posthog.com` (the PostHog Cloud US
 * endpoint the SDK falls back to when `api_host` is unset), matching the value
 * documented in `.env.example` / `docs/DOCKER.md`. The server defaults to the
 * EU host; the two are intentionally independent per region.
 */
export const PostHogConfigSchema = Type.Object({
	key: Type.Optional(
		Type.String({
			description:
				"PostHog public project token (NOT the server API key). Presence opts the SPA into telemetry.",
		}),
	),
	host: Type.String({
		format: "url",
		default: "https://app.posthog.com",
		description: "PostHog Cloud host for the browser client (e.g. https://app.posthog.com)",
	}),
});

/**
 * Resolved PostHog client config. The `enabled` discriminant is the telemetry
 * gate: `VITE_POSTHOG_KEY` unset ⇒ `{ enabled: false }` (no key, no host, no
 * PostHog code runs — see docs/posthog-privacy.md); set ⇒ both values are
 * validated and present. Modelling off/on as a union makes "enabled with an
 * empty key" unrepresentable, so consumers need no extra null-guards.
 */
export type ResolvedPostHogConfig =
	| { enabled: false }
	| { enabled: true; key: string; host: string };

/**
 * Parse gathered `VITE_POSTHOG_*` values into a resolved config.
 *
 * Pure — Vite's build-time substitution of `import.meta.env.VITE_*` happens at
 * the gather step (see `posthogConfig`), so this takes the already-read values.
 * `Value.Default` applies the documented host default; `Value.Parse` then
 * validates the host url format — so a malformed host fails here, at config
 * parse, rather than inside the PostHog SDK at runtime. Unlike Zod's `.parse()`,
 * `Value.Parse` does not apply defaults on its own, so both run in sequence.
 */
export function resolvePostHogConfig(raw: { key?: string; host?: string }): ResolvedPostHogConfig {
	const parsed = Value.Parse(
		PostHogConfigSchema,
		Value.Default(PostHogConfigSchema, { key: raw.key, host: raw.host }),
	);
	if (!parsed.key) return { enabled: false };
	return { enabled: true, key: parsed.key, host: parsed.host };
}

/**
 * The single resolved PostHog config all consumers import. Gathered once at
 * module load — Vite inlines the `import.meta.env.VITE_*` reads at build time,
 * so the values (and thus the resolved object) are constant for the bundle's
 * lifetime. Resolving here, not at each consumer, keeps the off-switch decision
 * and the parsed/defaulted shape in one site.
 */
export const posthogConfig: ResolvedPostHogConfig = resolvePostHogConfig({
	key: import.meta.env.VITE_POSTHOG_KEY,
	host: import.meta.env.VITE_POSTHOG_HOST,
});
