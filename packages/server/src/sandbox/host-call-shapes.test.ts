/// <reference types="bun" />
import { expect, test } from "bun:test";
import {
	Monty,
	MontyRuntimeError,
	MontySyntaxError,
	MontyError,
	MontyTypingError,
} from "@pydantic/monty";
import {
	describeShape,
	requireFeatureList,
	normalizeFindFeaturesParams,
	normalizeArea,
	normalizeFilterParams,
	normalizeSpatialJoinParams,
	normalizeDisplayData,
	formatGeocodeSummary,
	formatSearchSummary,
	formatFindFeaturesSummary,
	formatMontyError,
} from "./host-call-shapes.ts";
import type { Feature, GeocodeResult, FindFeaturesResult } from "@pixies/core/tools";

const feature = (id: string, name?: string): Feature => ({ id, name, lat: 53.48, lon: -2.24 });

// --- describeShape -----------------------------------------------------------

test("describeShape — null and undefined are 'None'", () => {
	expect(describeShape(null)).toBe("None");
	expect(describeShape(undefined)).toBe("None");
});

test("describeShape — array is 'list'", () => {
	expect(describeShape([1, 2, 3])).toBe("list");
	expect(describeShape([])).toBe("list");
});

test("describeShape — {features, count} is 'FeaturesEnvelope'", () => {
	expect(describeShape({ features: [], count: 0 })).toBe("FeaturesEnvelope");
});

test("describeShape — plain object is 'dict'", () => {
	expect(describeShape({ a: 1 })).toBe("dict");
	expect(describeShape({ features: [1] })).toBe("dict"); // count missing → not envelope
});

test("describeShape — primitives fall back to typeof", () => {
	expect(describeShape("s")).toBe("string");
	expect(describeShape(42)).toBe("number");
	expect(describeShape(true)).toBe("boolean");
});

// --- requireFeatureList ------------------------------------------------------

test("requireFeatureList — an array passes through unchanged", () => {
	const list = [feature("n1"), feature("n2")];
	expect(requireFeatureList(list, "features")).toBe(list);
});

test("requireFeatureList — a FeaturesEnvelope throws naming the envelope and the fix", () => {
	const envelope = { features: [feature("n1")], count: 1, truncated: false };
	expect(() => requireFeatureList(envelope, "points")).toThrow("points must be a list[Feature]");
	expect(() => requireFeatureList(envelope, "points")).toThrow("FeaturesEnvelope");
	expect(() => requireFeatureList(envelope, "points")).toThrow('points["features"]');
});

test("requireFeatureList — a plain dict throws without the envelope hint", () => {
	expect(() => requireFeatureList({ a: 1 }, "features")).toThrow(
		"features must be a list[Feature]",
	);
	expect(() => requireFeatureList({ a: 1 }, "features")).not.toThrow('features["features"]');
});

// --- normalizeArea -----------------------------------------------------------

test("normalizeArea — place", () => {
	expect(normalizeArea({ place: "Manchester" })).toEqual({ place: "Manchester" });
});

test("normalizeArea — bounds", () => {
	expect(
		normalizeArea({
			bounds: { minlat: 1, minlon: 2, maxlat: 3, maxlon: 4 },
		}),
	).toEqual({ bounds: { minlat: 1, minlon: 2, maxlat: 3, maxlon: 4 } });
});

test("normalizeArea — around", () => {
	expect(
		normalizeArea({
			around: { lat: 53.48, lon: -2.24, radius: 500 },
		}),
	).toEqual({ around: { lat: 53.48, lon: -2.24, radius: 500 } });
});

test("normalizeArea — a feature list under features", () => {
	const list = [feature("n1")];
	expect(normalizeArea({ features: list })).toEqual({ features: list });
});

test("normalizeArea — a single feature with lat/lon/radius coerces to around", () => {
	expect(normalizeArea({ features: { lat: 53.48, lon: -2.24, radius: 750 } })).toEqual({
		around: { lat: 53.48, lon: -2.24, radius: 750 },
	});
});

test("normalizeArea — missing area throws", () => {
	expect(() => normalizeArea(undefined)).toThrow("area is required");
});

test("normalizeArea — an unrecognized shape throws the 'must specify one of' error", () => {
	expect(() => normalizeArea({ foo: "bar" })).toThrow(
		"area must specify one of: place, bounds, around, features",
	);
});

// --- normalizeFindFeaturesParams --------------------------------------------

test("normalizeFindFeaturesParams — types are stringified, tags passed through, area normalized", () => {
	const out = normalizeFindFeaturesParams({
		types: ["cafe", 7],
		tags: [{ key: "amenity" }],
		area: { place: "Manchester" },
		name: " Espresso House ",
		limit: 10,
	});
	expect(out).toEqual({
		types: ["cafe", "7"],
		tags: [{ key: "amenity" }],
		area: { place: "Manchester" },
		name: " Espresso House ",
		limit: 10,
	});
});

test("normalizeFindFeaturesParams — optional fields are omitted when absent, area stays present", () => {
	const out = normalizeFindFeaturesParams({ area: { place: "London" } });
	expect(out).toEqual({ area: { place: "London" } });
	expect("types" in out).toBe(false);
	expect("name" in out).toBe(false);
});

// --- normalizeFilterParams ---------------------------------------------------

test("normalizeFilterParams — all fields carried through", () => {
	expect(
		normalizeFilterParams({
			where: "amenity='cafe'",
			tags: [{ key: "amenity" }],
			sort_by: "name",
			limit: 5,
			distinct: true,
		}),
	).toEqual({
		where: "amenity='cafe'",
		tags: [{ key: "amenity" }],
		sort_by: "name",
		limit: 5,
		distinct: true,
	});
});

test("normalizeFilterParams — sortBy aliases to sort_by", () => {
	expect(normalizeFilterParams({ sortBy: "name" })).toEqual({ sort_by: "name" });
});

test("normalizeFilterParams — empty input yields empty object", () => {
	expect(normalizeFilterParams({})).toEqual({});
});

// --- normalizeSpatialJoinParams ---------------------------------------------

test("normalizeSpatialJoinParams — defaults operation to 'near' and radius to 1000", () => {
	const list = [feature("n1")];
	const out = normalizeSpatialJoinParams({ points: list, targets: list });
	expect(out.operation).toBe("near");
	expect(out.radius).toBe(1000);
});

test("normalizeSpatialJoinParams — operation='nearest' is preserved", () => {
	const list = [feature("n1")];
	const out = normalizeSpatialJoinParams({
		points: list,
		targets: list,
		operation: "nearest",
		radius: 250,
	});
	expect(out.operation).toBe("nearest");
	expect(out.radius).toBe(250);
});

test("normalizeSpatialJoinParams — points/targets are shape-guarded as feature lists", () => {
	expect(() =>
		normalizeSpatialJoinParams({
			points: { features: [], count: 0 },
			targets: [],
		}),
	).toThrow("points must be a list[Feature]");
});

// --- normalizeDisplayData ----------------------------------------------------

test("normalizeDisplayData — selects only the recognized fields", () => {
	const list = [feature("n1")];
	expect(
		normalizeDisplayData({
			markers: [{ lat: 1, lon: 2 }],
			features: list,
			pairs: [],
			bounds: { minlat: 1, minlon: 2, maxlat: 3, maxlon: 4 },
		}),
	).toEqual({
		markers: [{ lat: 1, lon: 2 }],
		features: list,
		pairs: [],
		bounds: { minlat: 1, minlon: 2, maxlat: 3, maxlon: 4 },
	});
});

test("normalizeDisplayData — empty input yields empty DisplayData", () => {
	expect(normalizeDisplayData({})).toEqual({});
});

// --- formatGeocodeSummary ----------------------------------------------------

test("formatGeocodeSummary — null result reports 'no results'", () => {
	expect(formatGeocodeSummary("Nowhere", null)).toBe('geocode("Nowhere") → no results\n');
});

test("formatGeocodeSummary — uses the name and coordinates", () => {
	const result: GeocodeResult = {
		id: "x",
		name: "Manchester",
		lat: 53.4808,
		lon: -2.2426,
		display_name: "Manchester, UK",
	};
	expect(formatGeocodeSummary("Manchester", result)).toBe(
		'geocode("Manchester") → Manchester (53.4808, -2.2426)\n',
	);
});

test("formatGeocodeSummary — falls back to display_name's first segment when name is absent", () => {
	const result: GeocodeResult = {
		id: "x",
		lat: 53.4808,
		lon: -2.2426,
		display_name: "Manchester, UK",
	};
	expect(formatGeocodeSummary("Manchester", result)).toBe(
		'geocode("Manchester") → Manchester (53.4808, -2.2426)\n',
	);
});

// --- formatSearchSummary -----------------------------------------------------

test("formatSearchSummary — non-truncated carries the 'possibly incomplete' qualifier", () => {
	const out = formatSearchSummary("cafe", {
		count: 2,
		truncated: false,
		features: [feature("n1", "A"), feature("n2", "B")],
	});
	expect(out).toContain("(ranked, possibly incomplete)");
	expect(out).toContain("top: A, B");
});

test("formatSearchSummary — truncated escalates to '[capped]'", () => {
	const out = formatSearchSummary("cafe", {
		count: 50,
		truncated: true,
		features: [feature("n1", "A")],
	});
	expect(out).toContain("(ranked, incomplete) [capped]");
});

test("formatSearchSummary — empty feature list omits the top line", () => {
	const out = formatSearchSummary("cafe", { count: 0, truncated: false, features: [] });
	expect(out).not.toContain("top:");
});

// --- formatFindFeaturesSummary (covers formatAreaDesc + truncatedSuffix) ----

const ffResult = (over: Partial<FindFeaturesResult>): FindFeaturesResult => ({
	features: [],
	count: 0,
	truncated: false,
	...over,
});

test("formatFindFeaturesSummary — head line describes types, place area, count", () => {
	const out = formatFindFeaturesSummary(
		{ types: ["cafe", "restaurant"], area: { place: "Manchester" } },
		ffResult({ count: 3, features: [feature("n1", "A"), feature("n2", "B")] }),
	);
	expect(out).toContain("find_features(types=[cafe, restaurant], place=Manchester)");
	expect(out).toContain("3 feature(s)");
	expect(out).toContain("top: A, B");
});

test("formatFindFeaturesSummary — around/bounds area descriptors render", () => {
	const around = formatFindFeaturesSummary(
		{ types: ["x"], area: { around: { lat: 1, lon: 2, radius: 3 } } },
		ffResult({ count: 0 }),
	);
	expect(around).toContain("around={");
	const bounds = formatFindFeaturesSummary(
		{ types: ["x"], area: { bounds: { minlat: 1, minlon: 2, maxlat: 3, maxlon: 4 } } },
		ffResult({ count: 0 }),
	);
	expect(bounds).toContain("bounds={");
	const none = formatFindFeaturesSummary({ types: ["x"] }, ffResult({ count: 0 }));
	expect(none).toContain("features-based");
});

test("formatFindFeaturesSummary — non-array types render as 'none'", () => {
	const out = formatFindFeaturesSummary({ area: { place: "X" } }, ffResult({ count: 0 }));
	expect(out).toContain("types=[none]");
});

test("formatFindFeaturesSummary — truncated result appends '(showing N)'", () => {
	const out = formatFindFeaturesSummary(
		{ types: ["x"], area: { place: "X" } },
		ffResult({ count: 5, truncated: true, features: [feature("n1", "A"), feature("n2", "B")] }),
	);
	expect(out).toContain("5 feature(s) (showing 2)");
});

test("formatFindFeaturesSummary — 0-results without diagnosis is just the head", () => {
	const out = formatFindFeaturesSummary(
		{ types: ["x"], area: { place: "X" } },
		ffResult({ count: 0 }),
	);
	expect(out.endsWith("0 feature(s)\n")).toBe(true);
});

test("formatFindFeaturesSummary — 0-results with diagnosis renders the hint indented", () => {
	const out = formatFindFeaturesSummary(
		{ types: ["cofee"], area: { place: "X" } },
		ffResult({
			count: 0,
			diagnosis: { hint: 'retry with types=["cafe"]', typeMatch: ["cafe"] },
		}),
	);
	expect(out).toContain('retry with types=["cafe"]');
});

// --- formatMontyError --------------------------------------------------------

test("formatMontyError — RuntimeError surfaces its exception type and traceback", () => {
	const err = new MontyRuntimeError("ValueError", "bad value");
	expect(formatMontyError(err)).toEqual({
		errorType: "ValueError",
		message: "ValueError: bad value",
	});
});

test("formatMontyError — SyntaxError maps to errorType 'SyntaxError'", () => {
	const err = new MontySyntaxError("unexpected indent");
	const out = formatMontyError(err);
	expect(out.errorType).toBe("SyntaxError");
	expect(out.message).toContain("unexpected indent");
});

test("formatMontyError — a plain MontyError surfaces its type name", () => {
	const err = new MontyError("KeyError", "missing key");
	expect(formatMontyError(err)).toEqual({
		errorType: "KeyError",
		message: "KeyError: missing key",
	});
});

test("formatMontyError — plain Error falls back to RuntimeError + its message", () => {
	const out = formatMontyError(new Error("boom"));
	expect(out).toEqual({ errorType: "RuntimeError", message: "boom" });
});

test("formatMontyError — non-Error is stringified", () => {
	expect(formatMontyError("oops")).toEqual({ errorType: "RuntimeError", message: "oops" });
	expect(formatMontyError(42)).toEqual({ errorType: "RuntimeError", message: "42" });
});

test("formatMontyError — a real MontyTypingError (from typeCheck) maps to 'TypeError'", () => {
	// `typeCheck()` runs the static type pass and throws MontyTypingError on a
	// type mismatch — the deterministic way to obtain a real instance without a
	// sandbox run.
	const monty = new Monty("x: int = 'str'\n", { scriptName: "t.py" });
	let typingErr: unknown;
	try {
		monty.typeCheck();
	} catch (e) {
		typingErr = e;
	}
	expect(typingErr).toBeInstanceOf(MontyTypingError);
	const out = formatMontyError(typingErr);
	expect(out.errorType).toBe("TypeError");
	expect(out.message).toBe((typingErr as MontyTypingError).displayDiagnostics("concise"));
});
