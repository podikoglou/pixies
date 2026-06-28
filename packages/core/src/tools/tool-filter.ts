import { Type } from "typebox";
import type { Static } from "typebox";
import { defineTool, parseSchema } from "./tool-module.ts";
import type { DependencyContext } from "./dependency-graph.ts";
import { resolveRef } from "./dependency-graph.ts";
import type { StoredResult } from "./result-store.ts";
import type { StoredElement } from "./stored-element.ts";
import { computeBounds } from "./stored-element.ts";
import type { ToolProgress } from "./progress.ts";
import { FilterToolDetailsSchema, type FilterToolDetails } from "./schemas.ts";
import { throwIfAborted } from "./control-flow.ts";
import { textResult, formatContentLines } from "./content.ts";

const tagClauseSchema = Type.Object({
	key: Type.String(),
	value: Type.Optional(Type.String()),
	op: Type.Optional(
		Type.Union([
			Type.Literal("eq"),
			Type.Literal("neq"),
			Type.Literal("regex"),
			Type.Literal("iregex"),
			Type.Literal("exists"),
			Type.Literal("notexists"),
		]),
	),
});

const schema = Type.Object({
	queryRef: Type.String({
		description: "Tool call ID of the result set to filter.",
	}),
	where: Type.Optional(
		Type.String({
			description: `Predicate expression. Supports numeric (population < 30000), string (name =~ /stockholm/i), tag existence (population IS NOT NULL), AND/OR, parentheses.

Operators: =, !=, <, >, <=, >=, =~ (regex), !~ (not regex), IS NULL, IS NOT NULL.
Numbers parse OSM formats: "30 000" and "30,000" both equal 30000.
Regex: /pattern/i for case-insensitive. Quoted strings: 'literal' or "literal".`,
		}),
	),
	tags: Type.Optional(
		Type.Array(tagClauseSchema, {
			description:
				"Additional tag filters (AND with 'where'). Same semantics as find_features tags.",
		}),
	),
	sortBy: Type.Optional(
		Type.String({
			description:
				"Tag key to sort by. Prefix with '-' for descending. Example: '-population' or 'name'.",
		}),
	),
	limit: Type.Optional(
		Type.Number({ minimum: 1, description: "Max results to keep after filtering. Default: all." }),
	),
	distinct: Type.Optional(
		Type.Boolean({
			description: "If true, deduplicate by OSM element ID. Default false.",
		}),
	),
});

export type FilterContext = DependencyContext;

/** Predicate over a stored element. Compiled from a where-clause expression. */
type Predicate = (el: StoredElement) => boolean;

/**
 * Parse error from the where-clause parser. Surfaced as a tool error so the
 * model can correct the expression in the next turn rather than guessing.
 */
class WhereParseError extends Error {
	constructor(
		message: string,
		readonly position: number,
	) {
		super(message);
		this.name = "WhereParseError";
	}
}

/**
 * Recursive-descent parser + compiler for the `filter` tool's `where` clause.
 *
 * Grammar (lowest to highest precedence):
 *   orExpr   := andExpr ( OR andExpr )*
 *   andExpr  := primary ( AND primary )*
 *   primary  := '(' orExpr ')' | comparison
 *   comparison := IDENT OP literal | IDENT IS [NOT] NULL
 *
 * The compiler returns a `(el: StoredElement) => boolean` predicate.
 * Numeric comparisons normalise OSM's loose number formats
 * (`"30 000"`, `"30,000"`, `"~30000"`) so `population < 30000` works the
 * way Overpass's string comparison categorically cannot.
 */
function compileWhere(expr: string): Predicate {
	const tokens = tokenize(expr);
	if (tokens.length === 0) {
		throw new WhereParseError("empty expression", 0);
	}
	let pos = 0;
	const peek = () => tokens[pos];
	const next = () => tokens[pos++];

	function parseOr(): Predicate {
		let left = parseAnd();
		while (isKeyword(peek(), "or")) {
			next();
			const right = parseAnd();
			const l = left;
			const r = right;
			left = (el) => l(el) || r(el);
		}
		return left;
	}

	function parseAnd(): Predicate {
		let left = parsePrimary();
		while (isKeyword(peek(), "and")) {
			next();
			const right = parsePrimary();
			const l = left;
			const r = right;
			left = (el) => l(el) && r(el);
		}
		return left;
	}

	/** True when `t` is a keyword token with the given value. */
	function isKeyword(t: Token | undefined, value: "and" | "or" | "is" | "not" | "null"): boolean {
		return t !== undefined && t.type === "keyword" && t.value === value;
	}

	function parsePrimary(): Predicate {
		const t = peek();
		if (!t) throw new WhereParseError("unexpected end of expression", pos);
		if (t.type === "lparen") {
			next();
			const inner = parseOr();
			const close = next();
			if (!close || close.type !== "rparen") {
				throw new WhereParseError("expected ')'", pos);
			}
			return inner;
		}
		return parseComparison();
	}

	function parseComparison(): Predicate {
		const key = next();
		if (!key || key.type !== "ident") {
			throw new WhereParseError(`expected a tag key, got ${key ? key.type : "end"}`, pos);
		}
		// IS NULL / IS NOT NULL
		if (isKeyword(peek(), "is")) {
			next();
			const negate = isKeyword(peek(), "not");
			if (negate) next();
			const nul = next();
			if (!isKeyword(nul, "null")) {
				throw new WhereParseError("expected NULL after IS", pos);
			}
			return (el) => {
				const present = getTag(el, key.value) !== null;
				return negate ? present : !present;
			};
		}
		const op = next();
		if (!op || op.type !== "op") {
			throw new WhereParseError(`expected an operator after '${key.value}'`, pos);
		}
		const lit = next();
		if (!lit) throw new WhereParseError(`expected a value after operator`, pos);
		return buildComparisonPredicate(key.value, op.value, lit);
	}

	const predicate = parseOr();
	const extra = peek();
	if (extra) {
		throw new WhereParseError(`unexpected trailing token ${extra.type}`, pos);
	}
	return predicate;
}

/** Build the predicate for a single `key OP literal` comparison. */
function buildComparisonPredicate(key: string, op: string, lit: Token): Predicate {
	switch (op) {
		case "=~":
		case "!~": {
			const re = regexFromToken(lit);
			return (el) => {
				const v = getTag(el, key);
				if (v === null) return op === "!~";
				return op === "=~" ? re.test(v) : !re.test(v);
			};
		}
		case "IS":
		case "IS NOT": {
			const wantNull = op === "IS";
			return (el) => {
				const present = getTag(el, key) !== null;
				return wantNull ? !present : present;
			};
		}
		case "=":
		case "!=": {
			const want = literalAsString(lit);
			return (el) => {
				const v = getTag(el, key);
				if (v === null) return false;
				return op === "=" ? v === want : v !== want;
			};
		}
		case "<":
		case "<=":
		case ">":
		case ">=": {
			const target = literalAsNumber(lit);
			if (target === null) {
				throw new WhereParseError(
					`comparison '${op}' requires a number, got '${literalAsString(lit)}'`,
					0,
				);
			}
			return (el) => {
				const v = parseOsmNumber(getTag(el, key));
				if (v === null) return false;
				if (op === "<") return v < target;
				if (op === "<=") return v <= target;
				if (op === ">") return v > target;
				return v >= target;
			};
		}
		default:
			throw new WhereParseError(`unknown operator '${op}'`, 0);
	}
}

/** Read a tag value from the element; `tags.X` and bare `X` both work. */
function getTag(el: StoredElement, key: string): string | null {
	if (!el.tags) return null;
	const clean = key.startsWith("tags.") ? key.slice(5) : key;
	return el.tags[clean] ?? null;
}

/** Build a RegExp from a regex-literal token (`/pattern/flags`) or a bare string. */
function regexFromToken(t: Token): RegExp {
	if (t.type === "regex") {
		try {
			return new RegExp(t.value, t.flags ?? "");
		} catch (e) {
			throw new WhereParseError(`invalid regex /${t.value}/: ${(e as Error).message}`, 0);
		}
	}
	// Bare string after =~ — treat as a substring (case-insensitive) match.
	return new RegExp(escapeRegex(literalAsString(t)), "i");
}

/** Coerce a literal token to a string (strip quotes from quoted strings). */
function literalAsString(t: Token): string {
	switch (t.type) {
		case "string":
		case "number":
		case "regex":
		case "ident":
		case "op":
			return t.value;
		case "keyword":
			return t.value;
		case "lparen":
			return "(";
		case "rparen":
			return ")";
	}
}

/** Coerce a literal token to a number, or null when not numeric. */
function literalAsNumber(t: Token): number | null {
	if (t.type === "number") return parseOsmNumber(t.value);
	return parseOsmNumber(literalAsString(t));
}

/**
 * Normalise an OSM numeric tag value. Handles the formats the OSM community
 * actually uses for population/elevation/capacity: `"30 000"` (space
 * thousands), `"30,000"` (comma thousands), `"~30000"` / `"c. 30000"`
 * (approximate). Returns null for non-numeric.
 *
 * Rejects inputs that `Number()` would accept but the OSM data model never
 * intends: hex (`"0x10"`), numeric separators (`"1_000"`), bare signs, and
 * scientific notation (which doesn't appear in real OSM tags and surprises
 * users when it silently matches). The strict pattern is: optional `~`/`≈`/
 * `c.` prefix, optional sign, digits with optional thousands separators
 * (space or comma) and an optional decimal component.
 */
function parseOsmNumber(raw: string | null): number | null {
	if (raw === null) return null;
	const acceptable = /^\s*[~≈]?\s*(?:c\.\s*)?-?\d{1,3}(?:[ ,]?\d{3})*(?:\.\d+)?\s*$/;
	if (!acceptable.test(raw)) return null;
	const cleaned = raw
		.replace(/[\s,]/g, "")
		.replace(/^[~≈]?/, "")
		.replace(/^c\./i, "");
	const n = Number(cleaned);
	return Number.isFinite(n) ? n : null;
}

/** Escape regex metacharacters in a literal string for `new RegExp`. */
function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type Token =
	| { type: "ident"; value: string }
	| { type: "op"; value: string }
	| { type: "number"; value: string }
	| { type: "string"; value: string }
	| { type: "regex"; value: string; flags?: string }
	| { type: "keyword"; value: "and" | "or" | "is" | "not" | "null" }
	| { type: "lparen" }
	| { type: "rparen" };

/** Tokenizer for the where-clause grammar. */
function tokenize(s: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	const isIdentStart = (c: string) => /[a-zA-Z_]/.test(c);
	const isIdentCont = (c: string) => /[a-zA-Z0-9_.]/.test(c);
	while (i < s.length) {
		const c = s[i]!;
		if (c === " " || c === "\t" || c === "\n") {
			i++;
			continue;
		}
		if (c === "(") {
			tokens.push({ type: "lparen" });
			i++;
			continue;
		}
		if (c === ")") {
			tokens.push({ type: "rparen" });
			i++;
			continue;
		}
		// Regex literal: /pat/flags
		if (c === "/") {
			const end = findRegexEnd(s, i + 1);
			if (end === -1) throw new WhereParseError("unterminated regex literal", i);
			const body = s.slice(i + 1, end);
			i = end + 1;
			// Flags
			let flags = "";
			while (i < s.length && /[a-z]/.test(s[i]!)) {
				flags += s[i];
				i++;
			}
			tokens.push({ type: "regex", value: body, flags });
			continue;
		}
		// Quoted string
		if (c === '"' || c === "'") {
			const end = findStringEnd(s, i + 1, c);
			if (end === -1) throw new WhereParseError(`unterminated string starting at ${i}`, i);
			const body = s.slice(i + 1, end);
			i = end + 1;
			tokens.push({ type: "string", value: body });
			continue;
		}
		// Two-char operators
		const two = s.slice(i, i + 2);
		if (two === "<=" || two === ">=" || two === "!=" || two === "=~" || two === "!~") {
			tokens.push({ type: "op", value: two });
			i += 2;
			continue;
		}
		// Single-char operators
		if (c === "<" || c === ">" || c === "=") {
			tokens.push({ type: "op", value: c });
			i++;
			continue;
		}
		// Number
		if (/[0-9]/.test(c) || (c === "-" && /[0-9]/.test(s[i + 1] ?? ""))) {
			let j = i + 1;
			while (j < s.length && /[0-9.,\s]/.test(s[j]!)) j++;
			tokens.push({ type: "number", value: s.slice(i, j) });
			i = j;
			continue;
		}
		// Identifier or keyword
		if (isIdentStart(c)) {
			let j = i + 1;
			while (j < s.length && isIdentCont(s[j]!)) j++;
			const word = s.slice(i, j);
			i = j;
			const lower = word.toLowerCase();
			if (
				lower === "and" ||
				lower === "or" ||
				lower === "is" ||
				lower === "not" ||
				lower === "null"
			) {
				tokens.push({ type: "keyword", value: lower });
			} else {
				tokens.push({ type: "ident", value: word });
			}
			continue;
		}
		throw new WhereParseError(`unexpected character '${c}' at position ${i}`, i);
	}
	return tokens;
}

/** Find the closing `/` of a regex literal, skipping `\/` escapes. */
function findRegexEnd(s: string, start: number): number {
	let i = start;
	let inClass = false;
	while (i < s.length) {
		const c = s[i]!;
		if (c === "\\" && s[i + 1] === "/") {
			i += 2;
			continue;
		}
		if (c === "[") inClass = true;
		if (c === "]") inClass = false;
		if (c === "/" && !inClass) return i;
		i++;
	}
	return -1;
}

/** Find the closing quote of a string literal, skipping `\<quote>` escapes. */
function findStringEnd(s: string, start: number, quote: string): number {
	let i = start;
	while (i < s.length) {
		const c = s[i]!;
		if (c === "\\" && s[i + 1] === quote) {
			i += 2;
			continue;
		}
		if (c === quote) return i;
		i++;
	}
	return -1;
}

/** Apply the `tags` parameter as additional AND predicates. */
function applyTagsFilter(
	elements: StoredElement[],
	tags: Static<typeof schema>["tags"],
): StoredElement[] {
	if (!tags || tags.length === 0) return elements;
	return elements.filter((el) =>
		tags!.every((t) => {
			const v = getTag(el, t.key);
			if (v === null) return t.op === "notexists" || t.op === "neq";
			const op = t.op ?? "eq";
			if (op === "exists") return true;
			if (op === "notexists") return false;
			if (op === "eq") return v === (t.value ?? "");
			if (op === "neq") return v !== (t.value ?? "");
			if (op === "regex") {
				try {
					return new RegExp(t.value ?? "").test(v);
				} catch {
					return false;
				}
			}
			if (op === "iregex") {
				try {
					return new RegExp(t.value ?? "", "i").test(v);
				} catch {
					return false;
				}
			}
			return false;
		}),
	);
}

/**
 * Apply the `sortBy` parameter. `-key` is descending; bare `key` is ascending.
 * Elements missing the tag sort after elements that have it; numeric-aware
 * when both sides parse as numbers (so `-population` doesn't string-sort).
 */
function applySortBy(elements: StoredElement[], sortBy: string): StoredElement[] {
	const desc = sortBy.startsWith("-");
	const key = desc ? sortBy.slice(1) : sortBy;
	const sorted = [...elements];
	sorted.sort((a, b) => {
		const av = getTag(a, key);
		const bv = getTag(b, key);
		if (av === null && bv === null) return 0;
		if (av === null) return 1;
		if (bv === null) return -1;
		const an = parseOsmNumber(av);
		const bn = parseOsmNumber(bv);
		if (an !== null && bn !== null) return desc ? bn - an : an - bn;
		return desc ? bv.localeCompare(av) : av.localeCompare(bv);
	});
	return sorted;
}

/** Render an element as a pipe-delimited content line (filter has no native formatter). */
function formatStoredElement(el: StoredElement): string {
	const segments: string[] = [el.id];
	if (el.lat !== undefined && el.lon !== undefined) segments.push(`${el.lat},${el.lon}`);
	if (el.name) segments.push(el.name);
	const tags = el.tags ? Object.entries(el.tags).filter(([k]) => k !== "name") : [];
	if (tags.length > 0) segments.push(tags.map(([k, v]) => `${k}=${v}`).join(", "));
	return segments.join(" | ");
}

export const filterModule = defineTool<
	{ kind: "filter"; entries: StoredElement[] },
	FilterContext,
	typeof schema,
	ToolProgress | FilterToolDetails
>({
	name: "filter",
	label: "Filter Results",
	description: `Filter a previous result set in-memory. Executes instantly — no external call. Use for numeric comparisons Overpass cannot do correctly (population < 30000 — Overpass string-compares and breaks on "30 000"), string patterns on tag values, tag existence, sorting, limiting, and deduplication.

Required: queryRef (a prior find_features / filter / spatial_join / geocode tool call ID). The 'where' expression supports AND/OR, parentheses, and the operators =, !=, <, >, <=, >=, =~ (regex), !~, IS NULL, IS NOT NULL. Regex literals use /pattern/i form.`,
	parameters: schema,
	detailsSchema: FilterToolDetailsSchema,
	parse: parseSchema(FilterToolDetailsSchema, (d) => ({ kind: "filter", entries: d.data })),
	execute: async (ctx, toolCallId, params, signal) => {
		throwIfAborted(signal);
		const reg = ctx.coordinator.register(toolCallId);
		let stored: StoredResult | null = null;
		let pendingCause: unknown;
		try {
			const upstream = await resolveRef(ctx, toolCallId, params.queryRef, signal);
			let elements: StoredElement[] = upstream.elements;

			if (params.where) {
				const predicate = compileWhere(params.where);
				elements = elements.filter(predicate);
			}
			elements = applyTagsFilter(elements, params.tags);
			if (params.distinct) {
				const seen = new Set<string>();
				elements = elements.filter((el) => {
					if (seen.has(el.id)) return false;
					seen.add(el.id);
					return true;
				});
			}
			if (params.sortBy) elements = applySortBy(elements, params.sortBy);
			if (params.limit !== undefined) elements = elements.slice(0, params.limit);

			stored = {
				toolCallId,
				toolName: "filter",
				timestamp: Date.now(),
				elements,
			};
			const bounds = computeBounds(elements) ?? undefined;
			const text =
				elements.length === 0
					? "No results after filtering."
					: formatContentLines(elements, formatStoredElement, (rest) => `…and ${rest} more.`);
			return {
				...textResult(text),
				details: {
					data: elements.map((el) => ({
						id: el.id,
						...(el.type ? { type: el.type } : {}),
						...(el.lat !== undefined && el.lon !== undefined ? { lat: el.lat, lon: el.lon } : {}),
						...(el.name ? { name: el.name } : {}),
						...(el.tags ? { tags: el.tags } : {}),
					})),
					...(bounds ? { bounds } : {}),
					filterStats: {
						inputCount: upstream.elements.length,
						outputCount: elements.length,
						filteredOut: upstream.elements.length - elements.length,
					},
				},
			};
		} catch (e) {
			pendingCause = e;
			throw e;
		} finally {
			reg.done(stored, stored ? undefined : pendingCause);
		}
	},
});
