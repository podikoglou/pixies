import { z } from "zod";

export const PixiesConfigSchema = z.object({
	model: z
		.string()
		.regex(/^[^/]+\/.+/)
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
	userAgent: z.string().default("Pixies").describe("Custom User-Agent for OSM requests"),
	host: z.string().default("127.0.0.1").describe("Server listen hostname"),
	port: z.coerce
		.number()
		.int()
		.min(1)
		.max(65535)
		.default(3000)
		.describe("Server listen port"),
	thinkingLevel: z
		.enum(["off", "low", "medium", "high"] as const)
		.default("off")
		.describe("AI thinking level"),
	dbFile: z.string().default("pixies.db").describe("Path to SQLite database file"),
	cacheSize: z.coerce.number().int().min(0).default(50).describe("Max number of in-memory conversations"),
	httpRateLimit: z
		.coerce.number()
		.int()
		.min(0)
		.default(30)
		.describe("Max POST requests per IP per rate-limit window (0 disables)"),
	httpRateLimitWindowMs: z
		.coerce.number()
		.int()
		.min(1)
		.default(60_000)
		.describe("Per-IP HTTP rate-limit window length (ms)"),
	trustProxy: z
		.boolean()
		.default(false)
		.describe("Honor X-Forwarded-For for client IP (set true behind Caddy/Nginx)"),
	nominatimConcurrency: z
		.coerce.number()
		.int()
		.min(1)
		.default(1)
		.describe("Max concurrent in-flight Nominatim requests (default-instance policy: 1)"),
	nominatimIntervalCap: z
		.coerce.number()
		.int()
		.min(1)
		.default(1)
		.describe("Max Nominatim requests started per interval window (default-instance policy: 1)"),
	nominatimIntervalMs: z
		.coerce.number()
		.int()
		.min(1)
		.default(1100)
		.describe("Nominatim interval window length in ms (default-instance policy: 1100 → ~1 req/s)"),
	overpassConcurrency: z
		.coerce.number()
		.int()
		.min(1)
		.default(2)
		.describe("Max concurrent in-flight Overpass requests (default-instance policy: 2)"),
	overpassIntervalCap: z
		.coerce.number()
		.int()
		.min(1)
		.default(2)
		.describe("Max Overpass requests started per interval window (default-instance policy: 2)"),
	overpassIntervalMs: z
		.coerce.number()
		.int()
		.min(1)
		.default(1000)
		.describe("Overpass interval window length in ms (default-instance policy: 1000)"),
	discordWebhookUrl: z
		.string()
		.url()
		.optional()
		.describe("Discord webhook URL to receive error/fatal log alerts"),
});

export type ResolvedPixiesConfig = z.output<typeof PixiesConfigSchema>;
