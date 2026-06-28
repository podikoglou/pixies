import type { TagClause } from "./schemas.ts";

// Re-export so the existing import sites (`./find-features-types`) keep
// working after TagClause moved to schemas.ts as the single source of truth.
export type { TagClause };

/**
 * Human-readable feature type → OSM tag clauses. The dictionary is the
 * model-facing abstraction that lets `find_features` accept "restaurant" /
 * "LIDL" / "hospital" without the model hand-writing Overpass tags.
 *
 * Each entry maps to a list of OR-groups; each group is a conjunction (AND)
 * of tag clauses. Groups are OR'd in the generated query. The dictionary is
 * deliberately scoped to ~30 high-yield types — misses fall back to a
 * case-insensitive `name` regex (see {@link resolveType}).
 *
 * Co-located with `find_features` (single consumer); the prefix mirrors
 * `geocode-entry.ts` for the same reason.
 */

/** A resolved type — a list of OR-groups; each group is an AND of clauses. */
export type ResolvedType = TagClause[][];

const amenity = (value: string): TagClause[] => [{ key: "amenity", value }];

const shop = (value: string): TagClause[] => [{ key: "shop", value }];

const railway = (value: string): TagClause[] => [{ key: "railway", value }];

const highway = (value: string): TagClause[] => [{ key: "highway", value }];

const tourism = (value: string): TagClause[] => [{ key: "tourism", value }];

const leisure = (value: string): TagClause[] => [{ key: "leisure", value }];

const place = (value: string): TagClause[] => [{ key: "place", value }];

const office = (value: string): TagClause[] => [{ key: "office", value }];

/**
 * The canonical type dictionary. Keys are lowercased; lookup is
 * case-insensitive (see {@link resolveType}). Keep entries grouped by domain
 * for skimmability.
 */
export const TYPE_DICTIONARY: Record<string, ResolvedType> = {
	// --- Settlements ---
	town: [place("town")],
	city: [place("city")],
	village: [place("village")],
	hamlet: [place("hamlet")],
	suburb: [place("suburb")],
	neighbourhood: [place("neighbourhood")],
	borough: [place("borough")],

	// --- Food & drink ---
	restaurant: [amenity("restaurant")],
	cafe: [amenity("cafe")],
	bar: [amenity("bar")],
	pub: [amenity("pub")],
	fast_food: [amenity("fast_food")],
	fastfood: [amenity("fast_food")],
	bakery: [shop("bakery")],
	ice_cream: [amenity("ice_cream"), shop("ice_cream")],

	// --- Shopping ---
	supermarket: [shop("supermarket")],
	convenience_store: [shop("convenience")],
	convenience: [shop("convenience")],
	mall: [shop("mall")],
	clothes: [shop("clothes")],
	electronics: [shop("electronics")],
	books: [shop("books")],
	bookstore: [shop("books")],
	butcher: [shop("butcher")],

	// --- Transport ---
	bus_stop: [highway("bus_stop")],
	bus_station: [amenity("bus_station")],
	train_station: [railway("station")],
	metro_station: [railway("subway")],
	subway_station: [railway("subway")],
	tram_stop: [railway("tram_stop")],
	taxi_stand: [amenity("taxi")],
	airport: [amenity("airport"), [{ key: "aeroway", value: "aerodrome" }]],

	// --- Accommodation ---
	hotel: [tourism("hotel")],
	hostel: [tourism("hostel")],
	guest_house: [tourism("guest_house")],
	campsite: [tourism("camp_site")],

	// --- Infrastructure ---
	hospital: [amenity("hospital")],
	clinic: [amenity("clinic")],
	pharmacy: [amenity("pharmacy")],
	school: [amenity("school")],
	university: [amenity("university")],
	library: [amenity("library")],
	post_office: [amenity("post_office")],
	police: [amenity("police")],
	fire_station: [amenity("fire_station")],
	toilet: [amenity("toilets")],
	toilets: [amenity("toilets")],
	drinking_water: [amenity("drinking_water")],
	charging_station: [amenity("charging_station")],
	fuel: [amenity("fuel")],
	parking: [amenity("parking")],

	// --- Leisure ---
	park: [leisure("park")],
	playground: [leisure("playground")],
	swimming_pool: [leisure("swimming_pool")],
	gym: [leisure("fitness_centre"), leisure("sports_centre")],
	fitness_centre: [leisure("fitness_centre")],
	sports_centre: [leisure("sports_centre")],
	cinema: [amenity("cinema")],
	theatre: [amenity("theatre")],
	nightclub: [amenity("nightclub")],
	museum: [tourism("museum")],
	art_gallery: [tourism("gallery")],
	zoo: [tourism("zoo")],

	// --- Places of worship ---
	church: [amenity("place_of_worship")],
	mosque: [amenity("place_of_worship")],
	synagogue: [amenity("place_of_worship")],
	temple: [amenity("place_of_worship")],
	place_of_worship: [amenity("place_of_worship")],

	// --- Other ---
	atm: [amenity("atm")],
	bank: [amenity("bank"), office("bank")],
	bicycle_rental: [amenity("bicycle_rental")],
	car_rental: [amenity("car_rental")],
	bench: [amenity("bench")],
	fountain: [amenity("fountain")],
	recycling: [amenity("recycling")],
	waste_basket: [amenity("waste_basket")],
};

/**
 * Resolve a human-readable type to its tag clauses. Case-insensitive and
 * whitespace-trimming on the lookup key. Aliases (`fastfood` → `fast_food`,
 * `convenience` → `convenience_store`, etc.) are encoded as separate
 * dictionary entries above.
 *
 * Returns `null` for unknown types — the caller falls back to a
 * case-insensitive `name` regex, so an unknown type is still useful (it
 * becomes a name search) rather than a hard error.
 */
export function resolveType(input: string): ResolvedType | null {
	const key = input.trim().toLowerCase();
	return TYPE_DICTIONARY[key] ?? null;
}
