const DEFAULT_OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const DEFAULT_NOMINATIM_URL = "https://nominatim.openstreetmap.org";
const USER_AGENT = "Pixies";

export const config = {
	overpassUrl: process.env.PIXIES_OVERPASS_URL ?? DEFAULT_OVERPASS_URL,
	nominatimUrl: process.env.PIXIES_NOMINATIM_URL ?? DEFAULT_NOMINATIM_URL,
	contactEmail: process.env.PIXIES_CONTACT_EMAIL,
	userAgent: USER_AGENT,
};
