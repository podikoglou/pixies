import type { TagClause } from "./find-features-types.ts";

/**
 * Brand dictionary for `find_features`. Brands are a special case of the
 * type dictionary: the same name can be tagged multiple ways in OSM
 * (`brand=LIDL`, `name=Lidl`, sometimes `name=LIDL`), and the shop value
 * varies (a LIDL is usually `shop=supermarket` but occasionally
 * `shop=convenience` or untagged). The dictionary encodes the variants
 * we know; unknown brands fall back to a `brand` + `name` regex union
 * (see {@link resolveBrand}).
 *
 * Each known brand has `required` clauses (always present in a match) and
 * `optional` shop-value variants. The resolver produces one OR-group per
 * optional value (each AND-ed with `required`), plus a name-only fallback
 * group — so a LIDL missing its `brand` tag but named "Lidl" still matches.
 *
 * Scoped to a starter set of ~15 globally-recognised brands for the
 * experiment; the unknown-brand fallback covers the long tail.
 */
/**
 * Each known brand has `required` clauses (always present in a match) and
 * `optional` shop-value variants — each variant is a separate OR-group
 * AND-ed with `required`. The resolver appends a name-only fallback group
 * so a brand missing its `brand` tag but named correctly still matches.
 */
export interface BrandEntry {
	/** Always-AND clauses; usually `brand~NAME,i`. */
	required: TagClause[];
	/** Each inner array is one OR-group variant, AND-ed with `required`. */
	optional: TagClause[][];
}

const BRAND_REQUIRED = (brand: string): TagClause[] => [
	{ key: "brand", value: brand, op: "iregex" },
];

const SHOP = (value: string): TagClause[] => [{ key: "shop", value }];

const AMENITY = (value: string): TagClause[] => [{ key: "amenity", value }];

/** Known-brand dictionary; keys are lowercased brand names. */
export const BRAND_DICTIONARY: Record<string, BrandEntry> = {
	ikea: {
		required: BRAND_REQUIRED("ikea"),
		optional: [SHOP("furniture"), SHOP("department_store")],
	},
	lidl: { required: BRAND_REQUIRED("lidl"), optional: [SHOP("supermarket"), SHOP("convenience")] },
	aldi: { required: BRAND_REQUIRED("aldi"), optional: [SHOP("supermarket")] },
	rewe: { required: BRAND_REQUIRED("rewe"), optional: [SHOP("supermarket")] },
	carrefour: {
		required: BRAND_REQUIRED("carrefour"),
		optional: [SHOP("supermarket"), SHOP("hypermarket"), SHOP("convenience")],
	},
	tesco: {
		required: BRAND_REQUIRED("tesco"),
		optional: [SHOP("supermarket"), SHOP("convenience"), SHOP("department_store")],
	},
	sainsburys: {
		required: BRAND_REQUIRED("sainsbury"),
		optional: [SHOP("supermarket"), SHOP("convenience")],
	},
	asda: { required: BRAND_REQUIRED("asda"), optional: [SHOP("supermarket")] },
	morrisons: { required: BRAND_REQUIRED("morrisons"), optional: [SHOP("supermarket")] },
	walmart: {
		required: BRAND_REQUIRED("walmart"),
		optional: [SHOP("supermarket"), SHOP("department_store"), SHOP("general")],
	},
	target: {
		required: BRAND_REQUIRED("target"),
		optional: [SHOP("department_store"), SHOP("supermarket")],
	},
	costco: {
		required: BRAND_REQUIRED("costco"),
		optional: [SHOP("wholesale"), SHOP("supermarket")],
	},
	"7-eleven": { required: BRAND_REQUIRED("7-eleven"), optional: [SHOP("convenience")] },
	seven_eleven: { required: BRAND_REQUIRED("7-eleven"), optional: [SHOP("convenience")] },
	mcdonalds: {
		required: BRAND_REQUIRED("mcdonald"),
		optional: [AMENITY("fast_food"), AMENITY("restaurant")],
	},
	starbucks: {
		required: BRAND_REQUIRED("starbucks"),
		optional: [AMENITY("cafe")],
	},
	subway: {
		required: BRAND_REQUIRED("subway"),
		optional: [AMENITY("fast_food")],
	},
	kfc: {
		required: BRAND_REQUIRED("kfc"),
		optional: [AMENITY("fast_food"), AMENITY("restaurant")],
	},
	burger_king: {
		required: BRAND_REQUIRED("burger king"),
		optional: [AMENITY("fast_food")],
	},
	hm: { required: BRAND_REQUIRED("h&m"), optional: [SHOP("clothes")] },
	zara: { required: BRAND_REQUIRED("zara"), optional: [SHOP("clothes")] },
};

/**
 * Resolve a brand name to its tag clauses. Known brands produce a list of
 * OR-groups: one per optional shop-value (each AND-ed with the required
 * clauses), plus a name-only fallback. Unknown brands produce a two-group
 * fallback: `brand~NAME,i` OR `name~NAME,i`.
 *
 * The name fallback is the load-bearing piece: OSM coverage of `brand=*` is
 * incomplete, so requiring it would silently miss real locations.
 *
 * Returns a non-empty list (callers may safely map over it).
 */
export function resolveBrand(input: string): TagClause[][] {
	const key = input.trim().toLowerCase();
	const entry = BRAND_DICTIONARY[key];
	const nameFallback: TagClause[] = [{ key: "name", value: input.trim(), op: "iregex" }];
	if (!entry) {
		return [[{ key: "brand", value: input.trim(), op: "iregex" }], nameFallback];
	}
	const groups: TagClause[][] = [];
	for (const opt of entry.optional) {
		groups.push([...entry.required, ...opt]);
	}
	groups.push(nameFallback);
	return groups;
}

/**
 * True when `input` matches a known brand. Used by `find_features` to decide
 * whether a `types` entry should go through brand resolution or the type
 * dictionary — a bare "LIDL" is a brand, "supermarket" is not.
 */
export function isBrand(input: string): boolean {
	const key = input.trim().toLowerCase();
	return key in BRAND_DICTIONARY;
}
