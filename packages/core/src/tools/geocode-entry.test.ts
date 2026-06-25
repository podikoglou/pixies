/// <reference types="bun" />
import { test, expect } from "bun:test";
import type { NominatimResult } from "../clients/nominatim.ts";
import { nominatimResultToData } from "./geocode-entry.ts";

/** Build a Nominatim result with required fields and given overrides. */
function result(overrides: Partial<NominatimResult> = {}): NominatimResult {
	return {
		place_id: 1,
		lat: "52.5",
		lon: "13.4",
		display_name: "Berlin, Germany",
		...overrides,
	};
}

test("maps every field of a fully-populated result", () => {
	expect(
		nominatimResultToData(
			result({
				name: "Berlin",
				class: "place",
				type: "city",
				osm_type: "relation",
				osm_id: 62422,
			}),
		),
	).toEqual({
		placeId: 1,
		lat: 52.5,
		lon: 13.4,
		name: "Berlin",
		displayName: "Berlin, Germany",
		class: "place",
		type: "city",
		osmType: "relation",
		osmId: 62422,
	});
});

test("falls back to the first display_name segment when name is absent", () => {
	expect(nominatimResultToData(result({ name: undefined }))).toEqual({
		placeId: 1,
		lat: 52.5,
		lon: 13.4,
		name: "Berlin",
		displayName: "Berlin, Germany",
	});
});

test("falls back to 'unknown' and omits empty optionals entirely", () => {
	// `name` and `display_name` are present-but-empty (valid strings) so the
	// fallback chain bottoms out at "unknown"; absent optionals are not spread.
	expect(nominatimResultToData(result({ name: "", display_name: "" }))).toEqual({
		placeId: 1,
		lat: 52.5,
		lon: 13.4,
		name: "unknown",
	});
});
