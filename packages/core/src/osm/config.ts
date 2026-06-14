const DEFAULT_OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const DEFAULT_NOMINATIM_URL = "https://nominatim.openstreetmap.org";
const USER_AGENT = "Pixies";

export interface OsmConfig {
	overpassUrl?: string;
	nominatimUrl?: string;
	contactEmail?: string;
	userAgent?: string;
}

export function resolveOsmConfig(overrides?: OsmConfig) {
	return {
		overpassUrl: overrides?.overpassUrl ?? DEFAULT_OVERPASS_URL,
		nominatimUrl: overrides?.nominatimUrl ?? DEFAULT_NOMINATIM_URL,
		contactEmail: overrides?.contactEmail,
		userAgent: overrides?.userAgent ?? USER_AGENT,
	};
}
