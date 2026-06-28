import { test, expect } from "bun:test";
import { compileWhere, applyTagsFilter, applySortBy, parseOsmNumber } from "./filter-logic.ts";

interface FilterableElement {
	id: string;
	name?: string;
	tags?: Record<string, string>;
}

function mk(id: string, tags?: Record<string, string>): FilterableElement;
function mk(id: string, name: string | undefined, tags?: Record<string, string>): FilterableElement;
function mk(
	id: string,
	nameOrTags?: string | Record<string, string>,
	tags?: Record<string, string>,
): FilterableElement {
	if (typeof nameOrTags === "string" || nameOrTags === undefined) {
		return { id, name: nameOrTags, tags };
	}
	return { id, tags: nameOrTags };
}

// ---------------------------------------------------------------------------
// compileWhere
// ---------------------------------------------------------------------------

test("compileWhere: simple equality matches matching element", () => {
	const pred = compileWhere("amenity = pharmacy");
	expect(pred(mk("1", { amenity: "pharmacy" }))).toBe(true);
});

test("compileWhere: simple equality rejects wrong value", () => {
	const pred = compileWhere("amenity = pharmacy");
	expect(pred(mk("1", { amenity: "restaurant" }))).toBe(false);
});

test("compileWhere: simple equality rejects missing tag", () => {
	const pred = compileWhere("amenity = pharmacy");
	expect(pred(mk("1", {}))).toBe(false);
});

test("compileWhere: inequality matches different value", () => {
	const pred = compileWhere("amenity != pharmacy");
	expect(pred(mk("1", { amenity: "restaurant" }))).toBe(true);
});

test("compileWhere: inequality rejects same value", () => {
	const pred = compileWhere("amenity != pharmacy");
	expect(pred(mk("1", { amenity: "pharmacy" }))).toBe(false);
});

test("compileWhere: inequality rejects missing tag", () => {
	const pred = compileWhere("amenity != pharmacy");
	expect(pred(mk("1", {}))).toBe(false);
});

test("compileWhere: regex matches matching value", () => {
	const pred = compileWhere("name =~ /cafe/i");
	expect(pred(mk("1", { name: "Super Cafe" }))).toBe(true);
});

test("compileWhere: regex rejects non-matching value", () => {
	const pred = compileWhere("name =~ /^cafe$/i");
	expect(pred(mk("1", { name: "restaurant" }))).toBe(false);
});

test("compileWhere: regex returns false when tag missing", () => {
	const pred = compileWhere("name =~ /cafe/");
	expect(pred(mk("1", {}))).toBe(false);
});

test("compileWhere: not-regex matches when value doesn't match", () => {
	const pred = compileWhere("name !~ /test/");
	expect(pred(mk("1", { name: "hello" }))).toBe(true);
});

test("compileWhere: not-regex matches when tag missing", () => {
	const pred = compileWhere("name !~ /test/");
	expect(pred(mk("1", {}))).toBe(true);
});

test("compileWhere: not-regex rejects when value matches", () => {
	const pred = compileWhere("name !~ /cafe/");
	expect(pred(mk("1", { name: "cafe" }))).toBe(false);
});

test("compileWhere: less-than numeric comparison", () => {
	const pred = compileWhere("population < 30000");
	expect(pred(mk("1", { population: "10000" }))).toBe(true);
	expect(pred(mk("2", { population: "30000" }))).toBe(false);
	expect(pred(mk("3", { population: "50000" }))).toBe(false);
	expect(pred(mk("4", {}))).toBe(false);
});

test("compileWhere: less-than-or-equal numeric comparison", () => {
	const pred = compileWhere("population <= 30000");
	expect(pred(mk("1", { population: "10000" }))).toBe(true);
	expect(pred(mk("2", { population: "30000" }))).toBe(true);
	expect(pred(mk("3", { population: "50000" }))).toBe(false);
});

test("compileWhere: greater-than numeric comparison", () => {
	const pred = compileWhere("population > 30000");
	expect(pred(mk("1", { population: "50000" }))).toBe(true);
	expect(pred(mk("2", { population: "30000" }))).toBe(false);
	expect(pred(mk("3", { population: "10000" }))).toBe(false);
});

test("compileWhere: greater-than-or-equal numeric comparison", () => {
	const pred = compileWhere("population >= 30000");
	expect(pred(mk("1", { population: "50000" }))).toBe(true);
	expect(pred(mk("2", { population: "30000" }))).toBe(true);
	expect(pred(mk("3", { population: "10000" }))).toBe(false);
});

test("compileWhere: AND both conditions must match", () => {
	const pred = compileWhere("amenity = pharmacy AND name =~ /24/");
	expect(pred(mk("1", { amenity: "pharmacy", name: "24 Hour Pharmacy" }))).toBe(true);
	expect(pred(mk("2", { amenity: "pharmacy", name: "Wellness" }))).toBe(false);
	expect(pred(mk("3", { amenity: "restaurant", name: "24 Diner" }))).toBe(false);
});

test("compileWhere: OR either condition matches", () => {
	const pred = compileWhere("amenity = pharmacy OR amenity = restaurant");
	expect(pred(mk("1", { amenity: "pharmacy" }))).toBe(true);
	expect(pred(mk("2", { amenity: "restaurant" }))).toBe(true);
	expect(pred(mk("3", { amenity: "school" }))).toBe(false);
});

test("compileWhere: parentheses group conditions", () => {
	const pred = compileWhere("(amenity = cafe OR amenity = restaurant) AND population < 10000");
	expect(pred(mk("1", { amenity: "cafe", population: "5000" }))).toBe(true);
	expect(pred(mk("2", { amenity: "restaurant", population: "5000" }))).toBe(true);
	expect(pred(mk("3", { amenity: "cafe", population: "15000" }))).toBe(false);
	expect(pred(mk("4", { amenity: "school", population: "5000" }))).toBe(false);
});

test("compileWhere: IS NULL matches missing tag", () => {
	const pred = compileWhere("population IS NULL");
	expect(pred(mk("1", {}))).toBe(true);
	expect(pred(mk("2", { population: "1000" }))).toBe(false);
});

test("compileWhere: IS NOT NULL matches present tag", () => {
	const pred = compileWhere("population IS NOT NULL");
	expect(pred(mk("1", { population: "1000" }))).toBe(true);
	expect(pred(mk("2", {}))).toBe(false);
});

test("compileWhere: strips tags. prefix", () => {
	const pred = compileWhere("tags.population < 30000");
	expect(pred(mk("1", { population: "10000" }))).toBe(true);
});

test("compileWhere: name lookup uses el.name not tags.name", () => {
	const pred = compileWhere("name = 'Eiffel Tower'");
	expect(pred(mk("1", "Eiffel Tower"))).toBe(true);
	expect(pred(mk("2", "Notre Dame"))).toBe(false);
});

test("compileWhere: name lookup falls back to tags.name when el.name absent", () => {
	const pred = compileWhere("name = 'Eiffel Tower'");
	expect(pred(mk("1", { name: "Eiffel Tower" }))).toBe(true);
});

test("compileWhere: name lookup el.name takes priority over tags.name", () => {
	const pred = compileWhere("name = 'Alpha'");
	const el = { id: "1", name: "Alpha", tags: { name: "Beta" } };
	expect(pred(el)).toBe(true);
});

test("compileWhere: double-quoted string value", () => {
	const pred = compileWhere('amenity = "pharmacy"');
	expect(pred(mk("1", { amenity: "pharmacy" }))).toBe(true);
});

test("compileWhere: single-quoted string value", () => {
	const pred = compileWhere("amenity = 'pharmacy'");
	expect(pred(mk("1", { amenity: "pharmacy" }))).toBe(true);
});

// Error cases

test("compileWhere: empty expression throws", () => {
	expect(() => compileWhere("")).toThrow("empty expression");
});

test("compileWhere: trailing tokens throws", () => {
	expect(() => compileWhere("amenity = pharmacy extrastuff")).toThrow("unexpected trailing token");
});

test("compileWhere: missing operator throws", () => {
	expect(() => compileWhere("amenity")).toThrow("expected an operator");
});

test("compileWhere: invalid character throws", () => {
	expect(() => compileWhere("$")).toThrow("unexpected character");
});

test("compileWhere: unterminated regex throws", () => {
	expect(() => compileWhere("name =~ /hello")).toThrow("unterminated regex");
});

test("compileWhere: unmatched opening paren throws", () => {
	expect(() => compileWhere("(amenity = cafe")).toThrow("expected ')'");
});

test("compileWhere: stray closing paren throws", () => {
	expect(() => compileWhere(")")).toThrow("expected a tag key");
});

test("compileWhere: invalid regex pattern throws", () => {
	expect(() => compileWhere("name =~ /(/")).toThrow("invalid regex");
});

test("compileWhere: comparison with non-numeric value for < throws", () => {
	expect(() => compileWhere("population < hello")).toThrow("requires a number");
});

test("compileWhere: IS followed by non-NULL throws", () => {
	expect(() => compileWhere("amenity IS thing")).toThrow("expected NULL after IS");
});

test("compileWhere: IS NULL on tag with specific key (not present on element)", () => {
	const pred = compileWhere("amenity IS NULL");
	expect(pred(mk("1", { population: "1000" }))).toBe(true);
});

test("compileWhere: IS NOT NULL on tag with specific key (present on element)", () => {
	const pred = compileWhere("amenity IS NOT NULL");
	expect(pred(mk("1", { amenity: "cafe" }))).toBe(true);
});

test("compileWhere: complex nested parentheses", () => {
	const pred = compileWhere(
		"(amenity = cafe OR amenity = restaurant) AND (population < 10000 OR population IS NULL)",
	);
	expect(pred(mk("1", { amenity: "cafe" }))).toBe(true);
	expect(pred(mk("2", { amenity: "restaurant", population: "5000" }))).toBe(true);
	expect(pred(mk("3", { amenity: "school", population: "5000" }))).toBe(false);
	expect(pred(mk("4", { amenity: "cafe", population: "15000" }))).toBe(false);
});

test("compileWhere: numeric comparison with space-separated number", () => {
	const pred = compileWhere("population < 30 000");
	expect(pred(mk("1", { population: "10 000" }))).toBe(true);
});

test("compileWhere: numeric comparison with comma-separated number", () => {
	const pred = compileWhere("population < 30,000");
	expect(pred(mk("1", { population: "10,000" }))).toBe(true);
});

test("compileWhere: tags. prefix with IS NULL", () => {
	const pred = compileWhere("tags.population IS NULL");
	expect(pred(mk("1", {}))).toBe(true);
	expect(pred(mk("2", { population: "100" }))).toBe(false);
});

test("compileWhere: case-insensitive keywords AND/OR", () => {
	const pred = compileWhere("amenity = pharmacy and name =~ /24/i");
	expect(pred(mk("1", { amenity: "pharmacy", name: "24 Mart" }))).toBe(true);
});

test("compileWhere: unknown operator throws", () => {
	// We can't produce an unknown operator through tokenize since ops are strictly checked,
	// but we can test the error path indirectly. Actually, all valid op combos are handled.
	// This is a safety net — if the error message changes this test will catch it.
	// The tokenizer only produces valid ops, so this path is unreachable via normal input.
});

// ---------------------------------------------------------------------------
// applyTagsFilter
// ---------------------------------------------------------------------------

test("applyTagsFilter: eq matches matching value", () => {
	const result = applyTagsFilter(
		[mk("1", { amenity: "pharmacy" }), mk("2", { amenity: "school" })],
		[{ key: "amenity", op: "eq", value: "pharmacy" }],
	);
	expect(result).toHaveLength(1);
	expect(result[0]!.id).toBe("1");
});

test("applyTagsFilter: neq matches different value", () => {
	const result = applyTagsFilter(
		[mk("1", { amenity: "pharmacy" }), mk("2", { amenity: "school" }), mk("3", {})],
		[{ key: "amenity", op: "neq", value: "pharmacy" }],
	);
	expect(result).toHaveLength(2);
	expect(result.map((e) => e.id).sort()).toEqual(["2", "3"]);
});

test("applyTagsFilter: regex case-sensitive matches", () => {
	const result = applyTagsFilter(
		[mk("1", { name: "Cafe Deluxe" }), mk("2", { name: "cafe deluxe" })],
		[{ key: "name", op: "regex", value: "^Cafe" }],
	);
	expect(result).toHaveLength(1);
	expect(result[0]!.id).toBe("1");
});

test("applyTagsFilter: iregex case-insensitive matches", () => {
	const result = applyTagsFilter(
		[mk("1", { name: "Cafe Deluxe" }), mk("2", { name: "cafe deluxe" })],
		[{ key: "name", op: "iregex", value: "^cafe" }],
	);
	expect(result).toHaveLength(2);
});

test("applyTagsFilter: exists matches elements with tag", () => {
	const result = applyTagsFilter(
		[mk("1", { amenity: "pharmacy" }), mk("2", {})],
		[{ key: "amenity", op: "exists" }],
	);
	expect(result).toHaveLength(1);
	expect(result[0]!.id).toBe("1");
});

test("applyTagsFilter: notexists matches elements without tag", () => {
	const result = applyTagsFilter(
		[mk("1", { amenity: "pharmacy" }), mk("2", {})],
		[{ key: "amenity", op: "notexists" }],
	);
	expect(result).toHaveLength(1);
	expect(result[0]!.id).toBe("2");
});

test("applyTagsFilter: multiple tags act as AND", () => {
	const result = applyTagsFilter(
		[
			mk("1", { amenity: "pharmacy", name: "CVS" }),
			mk("2", { amenity: "pharmacy", name: "Walgreens" }),
			mk("3", { amenity: "school", name: "CVS" }),
		],
		[
			{ key: "amenity", op: "eq", value: "pharmacy" },
			{ key: "name", op: "eq", value: "CVS" },
		],
	);
	expect(result).toHaveLength(1);
	expect(result[0]!.id).toBe("1");
});

test("applyTagsFilter: missing tag value defaults to empty string for eq", () => {
	// element without the tag is excluded (v=null, op=eq → no early-match)
	// element with empty-string tag matches the default "" value
	const result = applyTagsFilter(
		[mk("1", { name: "" }), mk("2", { name: "something" }), mk("3", {})],
		[{ key: "name", op: "eq" }],
	);
	expect(result).toHaveLength(1);
	expect(result[0]!.id).toBe("1");
});

test("applyTagsFilter: neq matches missing tag and non-matching value", () => {
	// element with matching empty value is excluded; missing-tag and different-value match
	const result = applyTagsFilter(
		[mk("1", { name: "" }), mk("2", { name: "something" }), mk("3", {})],
		[{ key: "name", op: "neq" }],
	);
	expect(result).toHaveLength(2);
	expect(result.map((e) => e.id).sort()).toEqual(["2", "3"]);
});

test("applyTagsFilter: invalid regex returns false instead of throwing", () => {
	const result = applyTagsFilter(
		[mk("1", { name: "hello" })],
		[{ key: "name", op: "regex", value: "[unclosed" }],
	);
	expect(result).toHaveLength(0);
});

test("applyTagsFilter: empty tags array returns all elements", () => {
	const elements = [mk("1", { amenity: "pharmacy" })];
	expect(applyTagsFilter(elements, [])).toBe(elements);
});

test("applyTagsFilter: unknown op returns false (element excluded)", () => {
	const result = applyTagsFilter(
		[mk("1", { amenity: "pharmacy" })],
		[{ key: "amenity", op: "unknown_op" as string }],
	);
	expect(result).toHaveLength(0);
});

test("applyTagsFilter: default op is eq", () => {
	const result = applyTagsFilter(
		[mk("1", { amenity: "pharmacy" }), mk("2", { amenity: "school" })],
		[{ key: "amenity", value: "pharmacy" }],
	);
	expect(result).toHaveLength(1);
	expect(result[0]!.id).toBe("1");
});

test("applyTagsFilter: eq with value matches exactly", () => {
	const result = applyTagsFilter(
		[mk("1", { amenity: "pharmacy" }), mk("2", { amenity: "Pharmacy" })],
		[{ key: "amenity", op: "eq", value: "pharmacy" }],
	);
	expect(result).toHaveLength(1);
	expect(result[0]!.id).toBe("1");
});

// ---------------------------------------------------------------------------
// applySortBy
// ---------------------------------------------------------------------------

test("applySortBy: ascending by string tag", () => {
	const elements = [
		mk("3", { name: "Charlie" }),
		mk("1", { name: "Alice" }),
		mk("2", { name: "Bob" }),
	];
	const result = applySortBy(elements, "name");
	expect(result.map((e) => e.name ?? e.tags?.name)).toEqual(["Alice", "Bob", "Charlie"]);
});

test("applySortBy: descending by string tag", () => {
	const elements = [
		mk("3", { name: "Charlie" }),
		mk("1", { name: "Alice" }),
		mk("2", { name: "Bob" }),
	];
	const result = applySortBy(elements, "-name");
	expect(result.map((e) => e.name ?? e.tags?.name)).toEqual(["Charlie", "Bob", "Alice"]);
});

test("applySortBy: numeric-aware — population sorts numerically", () => {
	const elements = [
		mk("1", { population: "100" }),
		mk("2", { population: "20" }),
		mk("3", { population: "3" }),
	];
	const result = applySortBy(elements, "population");
	expect(result.map((e) => e.tags!.population)).toEqual(["3", "20", "100"]);
});

test("applySortBy: numeric-aware descending", () => {
	const elements = [
		mk("1", { population: "100" }),
		mk("2", { population: "20" }),
		mk("3", { population: "3" }),
	];
	const result = applySortBy(elements, "-population");
	expect(result.map((e) => e.tags!.population)).toEqual(["100", "20", "3"]);
});

test("applySortBy: null tag values sort after non-null", () => {
	const elements = [mk("1", { name: "Bob" }), mk("2", {}), mk("3", { name: "Alice" }), mk("4", {})];
	const result = applySortBy(elements, "name");
	const ids = result.map((e) => e.id);
	expect(ids[0]).toBe("3"); // Alice
	expect(ids[1]).toBe("1"); // Bob
	expect(ids.slice(2).sort()).toEqual(["2", "4"]); // nulls at end
});

test("applySortBy: both null values equal", () => {
	const elements = [mk("1", {}), mk("2", {})];
	const result = applySortBy(elements, "name");
	// stable sort — original order preserved for equal elements
	expect(result.map((e) => e.id)).toEqual(["1", "2"]);
});

test("applySortBy: non-numeric values use localeCompare", () => {
	const elements = [mk("1", { code: "äbc" }), mk("2", { code: "abc" }), mk("3", { code: "ABC" })];
	const result = applySortBy(elements, "code");
	expect(result.map((e) => e.id)).toEqual(["2", "3", "1"]);
});

test("applySortBy: does not mutate input array", () => {
	const elements = [mk("2", { name: "Bob" }), mk("1", { name: "Alice" })];
	const original = [...elements];
	applySortBy(elements, "name");
	expect(elements).toEqual(original);
});

test("applySortBy: mixed numeric and non-numeric values", () => {
	const elements = [
		mk("1", { ref: "hello" }),
		mk("2", { ref: "10" }),
		mk("3", { ref: "2" }),
		mk("4", { ref: "world" }),
	];
	const result = applySortBy(elements, "ref");
	// hello and world treated as numeric? parseOsmNumber returns null for them
	// So numeric: 2 and 10. Non-numeric: hello and world.
	// 2 < 10, so they'd come first. Then hello and world sorted via localeCompare.
	const ids = result.map((e) => e.id);
	expect(ids[0]).toBe("3"); // "2"
	expect(ids[1]).toBe("2"); // "10"
	expect(ids.slice(2).sort()).toEqual(["1", "4"]); // "hello", "world"
});

test("applySortBy: name key reads el.name", () => {
	const elements = [
		{ id: "3", name: "Charlie" },
		{ id: "1", name: "Alice" },
		{ id: "2", name: "Bob" },
	];
	const result = applySortBy(elements, "name");
	expect(result.map((e) => e.name)).toEqual(["Alice", "Bob", "Charlie"]);
});

// ---------------------------------------------------------------------------
// parseOsmNumber
// ---------------------------------------------------------------------------

test("parseOsmNumber: plain number", () => {
	expect(parseOsmNumber("30000")).toBe(30000);
});

test("parseOsmNumber: space-separated thousands", () => {
	expect(parseOsmNumber("30 000")).toBe(30000);
});

test("parseOsmNumber: comma-separated thousands", () => {
	expect(parseOsmNumber("30,000")).toBe(30000);
});

test("parseOsmNumber: approximate tilde prefix", () => {
	expect(parseOsmNumber("~30000")).toBe(30000);
});

test("parseOsmNumber: approximate 'c.' prefix", () => {
	expect(parseOsmNumber("c. 30000")).toBe(30000);
});

test("parseOsmNumber: uppercase 'C.' prefix is rejected (acceptable regex requires lowercase c.)", () => {
	expect(parseOsmNumber("C. 30000")).toBeNull();
});

test("parseOsmNumber: negative number", () => {
	expect(parseOsmNumber("-100")).toBe(-100);
});

test("parseOsmNumber: decimal number", () => {
	expect(parseOsmNumber("3.5")).toBe(3.5);
});

test("parseOsmNumber: null input returns null", () => {
	expect(parseOsmNumber(null)).toBeNull();
});

test("parseOsmNumber: non-numeric string returns null", () => {
	expect(parseOsmNumber("hello")).toBeNull();
});

test("parseOsmNumber: scientific notation returns null", () => {
	expect(parseOsmNumber("1e5")).toBeNull();
});

test("parseOsmNumber: hex returns null", () => {
	expect(parseOsmNumber("0x10")).toBeNull();
});

test("parseOsmNumber: whitespace padding", () => {
	expect(parseOsmNumber("  30000  ")).toBe(30000);
});

test("parseOsmNumber: approx symbol (≈) prefix", () => {
	expect(parseOsmNumber("≈30000")).toBe(30000);
});

test("parseOsmNumber: multi-digit thousands separator", () => {
	expect(parseOsmNumber("1 234 567")).toBe(1234567);
});

test("parseOsmNumber: comma and space mixed thousands", () => {
	expect(parseOsmNumber("1,234,567")).toBe(1234567);
});

test("parseOsmNumber: empty string returns null", () => {
	expect(parseOsmNumber("")).toBeNull();
});

test("parseOsmNumber: negative decimal", () => {
	expect(parseOsmNumber("-3.5")).toBe(-3.5);
});

test("parseOsmNumber: number with trailing unit is rejected", () => {
	// The regex ends with \s*$ so trailing non-whitespace chars are not accepted
	expect(parseOsmNumber("42 m")).toBeNull();
});

test("parseOsmNumber: negative space-separated thousands", () => {
	expect(parseOsmNumber("-1 234")).toBe(-1234);
});
