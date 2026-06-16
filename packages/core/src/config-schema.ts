import { z } from "zod";

export const PixiesConfigSchema = z.object({
	model: z
		.string()
		.regex(/^[^/]+\/.+/)
		.describe('Model in "provider/model-id" format'),
	apiKey: z.string().describe("API key for the AI provider"),
	contactEmail: z.string().optional().describe("Contact email for OSM usage policy"),
	overpassUrl: z
		.string()
		.default("https://overpass-api.de/api/interpreter")
		.describe("Custom Overpass API URL"),
	nominatimUrl: z
		.string()
		.default("https://nominatim.openstreetmap.org")
		.describe("Custom Nominatim API URL"),
	userAgent: z.string().default("Pixies").describe("Custom User-Agent for OSM requests"),
	host: z.string().default("127.0.0.1").describe("Server listen hostname"),
	port: z.number().default(3000).describe("Server listen port"),
	thinkingLevel: z
		.enum(["off", "low", "medium", "high"] as const)
		.default("off")
		.describe("AI thinking level"),
	dbFile: z.string().default("pixies.db").describe("Path to SQLite database file"),
	cacheSize: z.number().default(50).describe("Max number of in-memory conversations"),
	httpRateLimit: z
		.number()
		.default(30)
		.describe("Max POST requests per IP per rate-limit window (0 disables)"),
	httpRateLimitWindowMs: z
		.number()
		.default(60_000)
		.describe("Per-IP HTTP rate-limit window length (ms)"),
	trustProxy: z
		.boolean()
		.default(false)
		.describe("Honor X-Forwarded-For for client IP (set true behind Caddy/Nginx)"),
	nominatimConcurrency: z
		.number()
		.default(1)
		.describe("Max concurrent in-flight Nominatim requests (default-instance policy: 1)"),
	nominatimIntervalCap: z
		.number()
		.default(1)
		.describe("Max Nominatim requests started per interval window (default-instance policy: 1)"),
	nominatimIntervalMs: z
		.number()
		.default(1100)
		.describe("Nominatim interval window length in ms (default-instance policy: 1100 → ~1 req/s)"),
	overpassConcurrency: z
		.number()
		.default(2)
		.describe("Max concurrent in-flight Overpass requests (default-instance policy: 2)"),
	overpassIntervalCap: z
		.number()
		.default(2)
		.describe("Max Overpass requests started per interval window (default-instance policy: 2)"),
	overpassIntervalMs: z
		.number()
		.default(1000)
		.describe("Overpass interval window length in ms (default-instance policy: 1000)"),
});

export type PixiesConfig = z.input<typeof PixiesConfigSchema>;
export type ResolvedPixiesConfig = z.output<typeof PixiesConfigSchema>;
