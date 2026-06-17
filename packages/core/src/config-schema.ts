import { z } from "zod";
import { getProviders } from "@earendil-works/pi-ai";

/**
 * Snapshot of pi-ai's known-provider registry, taken at module load.
 *
 * The registry is built once at pi-ai import time and never mutated, so a
 * module-load snapshot documents that assumption and avoids recomputing the
 * set on every config parse. Used by the `model` field's superRefine below and
 * by the defense-in-depth guard in `agent.ts` `resolveModel`.
 */
const KNOWN_PROVIDERS: ReadonlySet<string> = new Set(getProviders());

export const PixiesConfigSchema = z.object({
	model: z
		.string()
		.regex(/^[^/]+\/.+/)
		// Defense-in-depth alongside the runtime guard in agent.ts `resolveModel`.
		// The regex above only checks the "provider/model-id" shape; this superRefine
		// additionally validates the provider prefix against pi-ai's registry, so a
		// typo'd provider (e.g. `PIXIES_MODEL=antrophic/...`) fails fast at boot with
		// a message naming the valid providers. superRefine (rather than refine with a
		// message factory) because Zod v4's refine params type omits the dynamic-error
		// field; addIssue(string) gives the same dynamic message cleanly.
		.superRefine((val, ctx) => {
			const provider = val.slice(0, val.indexOf("/"));
			if (!KNOWN_PROVIDERS.has(provider)) {
				ctx.addIssue(
					`Unknown provider "${provider}". Valid providers: ${[...KNOWN_PROVIDERS].join(", ")}`,
				);
			}
		})
		.describe('Model in "provider/model-id" format'),
	apiKey: z.string().describe("API key for the AI provider"),
	contactEmail: z.string().email().optional().describe("Contact email for OSM usage policy"),
	overpassUrl: z
		.string()
		.url()
		.default("https://overpass-api.de/api/interpreter")
		.describe("Custom Overpass API URL"),
	nominatimUrl: z
		.string()
		.url()
		.default("https://nominatim.openstreetmap.org")
		.describe("Custom Nominatim API URL"),
	userAgent: z
		.string()
		.default("Pixies/1.0 (https://github.com/podikoglou/pixies)")
		.describe("Custom User-Agent for OSM requests"),
	host: z.string().default("127.0.0.1").describe("Server listen hostname"),
	port: z.coerce.number().int().min(1).max(65535).default(3000).describe("Server listen port"),
	thinkingLevel: z
		.enum(["off", "low", "medium", "high"] as const)
		.default("off")
		.describe("AI thinking level"),
	dbFile: z.string().default("pixies.db").describe("Path to SQLite database file"),
	cacheSize: z.coerce
		.number()
		.int()
		.min(0)
		.default(50)
		.describe("Max number of in-memory conversations"),
	httpRateLimit: z.coerce
		.number()
		.int()
		.min(0)
		.default(30)
		.describe("Max POST requests per IP per rate-limit window (0 disables)"),
	httpRateLimitWindowMs: z.coerce
		.number()
		.int()
		.min(1)
		.default(60_000)
		.describe("Per-IP HTTP rate-limit window length (ms)"),
	trustProxy: z
		.boolean()
		.default(false)
		.describe("Honor X-Forwarded-For for client IP (set true behind Caddy/Nginx)"),
	trustedProxyHops: z.coerce
		.number()
		.int()
		.min(0)
		.default(1)
		.describe("Number of trusted proxy hops when parsing X-Forwarded-For"),
	nominatimConcurrency: z.coerce
		.number()
		.int()
		.min(1)
		.default(1)
		.describe("Max concurrent in-flight Nominatim requests (default-instance policy: 1)"),
	nominatimIntervalCap: z.coerce
		.number()
		.int()
		.min(1)
		.default(1)
		.describe("Max Nominatim requests started per interval window (default-instance policy: 1)"),
	nominatimIntervalMs: z.coerce
		.number()
		.int()
		.min(1)
		.default(1100)
		.describe("Nominatim interval window length in ms (default-instance policy: 1100 → ~1 req/s)"),
	nominatimCacheTtlMs: z.coerce
		.number()
		.int()
		.min(0)
		.default(86_400_000)
		.describe(
			"TTL for cached Nominatim search/reverse responses in ms (default: 24h). 0 disables caching.",
		),
	nominatimCacheMaxEntries: z.coerce
		.number()
		.int()
		.min(0)
		.default(1000)
		.describe("Max cached Nominatim responses (LRU eviction). 0 disables caching."),
	overpassConcurrency: z.coerce
		.number()
		.int()
		.min(1)
		.default(2)
		.describe("Max concurrent in-flight Overpass requests (default-instance policy: 2)"),
	overpassIntervalCap: z.coerce
		.number()
		.int()
		.min(1)
		.default(2)
		.describe("Max Overpass requests started per interval window (default-instance policy: 2)"),
	overpassIntervalMs: z.coerce
		.number()
		.int()
		.min(1)
		.default(1000)
		.describe("Overpass interval window length in ms (default-instance policy: 1000)"),
	discordWebhookUrl: z
		.string()
		.url()
		.optional()
		.describe("Discord webhook URL to receive error/fatal log alerts"),
	conversationTokenBudget: z.coerce
		.number()
		.int()
		.min(0)
		.default(0)
		.describe(
			"Max tokens (input + output) a single conversation may consume across all turns. 0 = unlimited.",
		),
});

export type ResolvedPixiesConfig = z.output<typeof PixiesConfigSchema>;
