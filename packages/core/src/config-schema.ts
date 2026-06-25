import { Type, Refine } from "typebox";
import type { Static } from "typebox";
import { getProviders } from "@earendil-works/pi-ai";

/**
 * Snapshot of pi-ai's known-provider registry, taken at module load.
 *
 * The registry is built once at pi-ai import time and never mutated, so a
 * module-load snapshot documents that assumption and avoids recomputing the
 * set on every config parse. Used by the `model` field's Refine below and
 * by the defense-in-depth guard in `agent.ts` `resolveModel`.
 */
const KNOWN_PROVIDERS: ReadonlySet<string> = new Set(getProviders());

export const PixiesConfigSchema = Type.Object({
	model: Refine(
		// Defense-in-depth alongside the runtime guard in agent.ts `resolveModel`.
		// The pattern below only checks the "provider/model-id" shape; this Refine
		// additionally validates the provider prefix against pi-ai's registry, so a
		// typo'd provider (e.g. `PIXIES_MODEL=antrophic/...`) fails fast at boot with
		// a message naming the valid providers.
		Type.String({ pattern: "^[^/]+/.+", description: 'Model in "provider/model-id" format' }),
		(val) => {
			const provider = val.slice(0, val.indexOf("/"));
			return KNOWN_PROVIDERS.has(provider);
		},
		(val) => {
			const provider = val.slice(0, val.indexOf("/"));
			return `Unknown provider "${provider}". Valid providers: ${[...KNOWN_PROVIDERS].join(", ")}`;
		},
	),
	apiKey: Type.String({ description: "API key for the AI provider" }),
	contactEmail: Type.Optional(
		Type.String({ format: "email", description: "Contact email for OSM usage policy" }),
	),
	overpassUrl: Type.String({
		format: "url",
		default: "https://overpass-api.de/api/interpreter",
		description: "Custom Overpass API URL",
	}),
	nominatimUrl: Type.String({
		format: "url",
		default: "https://nominatim.openstreetmap.org",
		description: "Custom Nominatim API URL",
	}),
	userAgent: Type.String({
		default: "Pixies/1.0 (https://github.com/podikoglou/pixies)",
		description: "Custom User-Agent for OSM requests",
	}),
	host: Type.String({ default: "127.0.0.1", description: "Server listen hostname" }),
	port: Type.Integer({
		minimum: 1,
		maximum: 65535,
		default: 3000,
		description: "Server listen port",
	}),
	thinkingLevel: Type.Union(
		[Type.Literal("off"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")],
		{ default: "off", description: "AI thinking level" },
	),
	dbFile: Type.String({ default: "pixies.db", description: "Path to SQLite database file" }),
	cacheSize: Type.Integer({
		minimum: 0,
		default: 50,
		description: "Max number of in-memory conversations",
	}),
	httpRateLimit: Type.Integer({
		minimum: 0,
		default: 30,
		description: "Max POST requests per IP per rate-limit window (0 disables)",
	}),
	httpRateLimitWindowMs: Type.Integer({
		minimum: 1,
		default: 60_000,
		description: "Per-IP HTTP rate-limit window length (ms)",
	}),
	trustProxy: Type.Boolean({
		default: false,
		description: "Honor X-Forwarded-For for client IP (set true behind Caddy/Nginx)",
	}),
	trustedProxyHops: Type.Integer({
		minimum: 0,
		default: 1,
		description: "Number of trusted proxy hops when parsing X-Forwarded-For",
	}),
	nominatimConcurrency: Type.Integer({
		minimum: 1,
		default: 1,
		description: "Max concurrent in-flight Nominatim requests (default-instance policy: 1)",
	}),
	nominatimIntervalCap: Type.Integer({
		minimum: 1,
		default: 1,
		description: "Max Nominatim requests started per interval window (default-instance policy: 1)",
	}),
	nominatimIntervalMs: Type.Integer({
		minimum: 1,
		default: 1100,
		description:
			"Nominatim interval window length in ms (default-instance policy: 1100 → ~1 req/s)",
	}),
	nominatimCacheTtlMs: Type.Integer({
		minimum: 0,
		default: 86_400_000,
		description:
			"TTL for cached Nominatim search/reverse responses in ms (default: 24h). 0 disables caching.",
	}),
	nominatimCacheMaxEntries: Type.Integer({
		minimum: 0,
		default: 1000,
		description: "Max cached Nominatim responses (LRU eviction). 0 disables caching.",
	}),
	overpassConcurrency: Type.Integer({
		minimum: 1,
		default: 2,
		description: "Max concurrent in-flight Overpass requests (default-instance policy: 2)",
	}),
	overpassIntervalCap: Type.Integer({
		minimum: 1,
		default: 2,
		description: "Max Overpass requests started per interval window (default-instance policy: 2)",
	}),
	overpassIntervalMs: Type.Integer({
		minimum: 1,
		default: 1000,
		description: "Overpass interval window length in ms (default-instance policy: 1000)",
	}),
	discordWebhookUrl: Type.Optional(
		Type.String({
			format: "url",
			description: "Discord webhook URL to receive error/fatal log alerts",
		}),
	),
	posthogHost: Type.String({
		format: "url",
		default: "https://eu.i.posthog.com",
		description:
			"PostHog Cloud host for server-log shipping via OTel (e.g. https://eu.i.posthog.com)",
	}),
	posthogApiKey: Type.Optional(
		Type.String({
			description:
				"PostHog server token. When set, info+ server logs ship to PostHog Logs via OTel (off when unset). Server secret — never expose to the browser.",
		}),
	),
	conversationTokenBudget: Type.Integer({
		minimum: 0,
		default: 0,
		description:
			"Max tokens (input + output) a single conversation may consume across all turns. 0 = unlimited.",
	}),
});

export type ResolvedPixiesConfig = Static<typeof PixiesConfigSchema>;
