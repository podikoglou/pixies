/**
 * Model-facing message returned when Nominatim reports a server-busy
 * condition. Names the service so the model can tell the user which one is
 * down rather than collapsing both backing services into a generic "OSM".
 */
export const NOMINATIM_BUSY_MESSAGE =
	"Nominatim is currently overloaded or unavailable. This is a transient infrastructure issue — " +
	"do not retry this or a different Nominatim query. Tell the user that Nominatim is temporarily " +
	"unavailable and suggest they try again later.";

/**
 * Model-facing message returned when Overpass reports a server-busy condition.
 * See {@link NOMINATIM_BUSY_MESSAGE} for why each service carries its own copy.
 */
export const OVERPASS_BUSY_MESSAGE =
	"Overpass is currently overloaded or unavailable. This is a transient infrastructure issue — " +
	"do not retry this or a different Overpass query. Tell the user that Overpass is temporarily " +
	"unavailable and suggest they try again later.";
