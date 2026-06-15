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
	maxConversations: z.number().default(100).describe("Maximum concurrent conversations"),
	maxMessages: z.number().default(50).describe("Maximum messages per conversation"),
	logLevel: z
		.enum(["debug", "info", "warn", "error"] as const)
		.default("info")
		.describe("Logging level"),
	defaultLimit: z.number().default(10).describe("Default result limit for geocode/tool calls"),
});

export type PixiesConfig = z.input<typeof PixiesConfigSchema>;
export type ResolvedPixiesConfig = z.output<typeof PixiesConfigSchema>;
