import { Type, type Static } from "typebox";

export const PixiesConfigSchema = Type.Object({
	model: Type.String({ description: 'Model in "provider/model-id" format' }),
	apiKey: Type.String({ description: "API key for the AI provider" }),
	contactEmail: Type.Optional(Type.String({ description: "Contact email for OSM usage policy" })),
	overpassUrl: Type.Optional(Type.String({ description: "Custom Overpass API URL" })),
	nominatimUrl: Type.Optional(Type.String({ description: "Custom Nominatim API URL" })),
	userAgent: Type.Optional(Type.String({ description: "Custom User-Agent for OSM requests" })),
});

export type PixiesConfig = Static<typeof PixiesConfigSchema>;
