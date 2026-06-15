import { Type, type Static } from "typebox";

export const PixiesConfigSchema = Type.Object({
	model: Type.String({ description: 'Model in "provider/model-id" format' }),
	apiKey: Type.String({ description: "API key for the AI provider" }),
	contactEmail: Type.Optional(Type.String({ description: "Contact email for OSM usage policy" })),
	overpassUrl: Type.Optional(
		Type.String({
			description: "Custom Overpass API URL",
			default: "https://overpass-api.de/api/interpreter",
		}),
	),
	nominatimUrl: Type.Optional(
		Type.String({
			description: "Custom Nominatim API URL",
			default: "https://nominatim.openstreetmap.org",
		}),
	),
	userAgent: Type.Optional(
		Type.String({ description: "Custom User-Agent for OSM requests", default: "Pixies" }),
	),
	host: Type.Optional(Type.String({ description: "Server listen hostname", default: "127.0.0.1" })),
	port: Type.Optional(Type.Number({ description: "Server listen port", default: 3000 })),
	thinkingLevel: Type.Optional(
		Type.Union(
			[Type.Literal("off"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")],
			{ description: "AI thinking level", default: "off" },
		),
	),
	maxConversations: Type.Optional(
		Type.Number({ description: "Maximum concurrent conversations", default: 100 }),
	),
	maxMessages: Type.Optional(
		Type.Number({ description: "Maximum messages per conversation", default: 50 }),
	),
	logLevel: Type.Optional(
		Type.Union(
			[Type.Literal("debug"), Type.Literal("info"), Type.Literal("warn"), Type.Literal("error")],
			{ description: "Logging level", default: "info" },
		),
	),
	defaultLimit: Type.Optional(
		Type.Number({ description: "Default result limit for geocode/tool calls", default: 10 }),
	),
});

export type PixiesConfig = Static<typeof PixiesConfigSchema>;
