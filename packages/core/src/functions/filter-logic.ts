interface FilterableElement {
	id: string;
	name?: string;
	tags?: Record<string, string>;
}

type Predicate = (el: FilterableElement) => boolean;

class WhereParseError extends Error {
	constructor(
		message: string,
		readonly position: number,
	) {
		super(message);
		this.name = "WhereParseError";
	}
}

/** Compile a filter expression into a predicate. Supports `and`/`or`/`not`, comparisons (`=`, `!=`, `=~`, `<`, `<=`, `>`, `>=`), and `exists`/`notexists`. */
export function compileWhere(expr: string): Predicate {
	const tokens = tokenize(expr);
	if (tokens.length === 0) throw new WhereParseError("empty expression", 0);
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
			if (!close || close.type !== "rparen") throw new WhereParseError("expected ')'", pos);
			return inner;
		}
		return parseComparison();
	}

	function parseComparison(): Predicate {
		const key = next();
		if (!key || key.type !== "ident")
			throw new WhereParseError(`expected a tag key, got ${key ? key.type : "end"}`, pos);
		if (isKeyword(peek(), "is")) {
			next();
			const negate = isKeyword(peek(), "not");
			if (negate) next();
			const nul = next();
			if (!isKeyword(nul, "null")) throw new WhereParseError("expected NULL after IS", pos);
			return (el) => {
				const present = getTag(el, key.value) !== null;
				return negate ? present : !present;
			};
		}
		const op = next();
		if (!op || op.type !== "op")
			throw new WhereParseError(`expected an operator after '${key.value}'`, pos);
		const lit = next();
		if (!lit) throw new WhereParseError("expected a value after operator", pos);
		return buildComparisonPredicate(key.value, op.value, lit);
	}

	const predicate = parseOr();
	const extra = peek();
	if (extra) throw new WhereParseError(`unexpected trailing token ${extra.type}`, pos);
	return predicate;
}

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
			if (target === null)
				throw new WhereParseError(
					`comparison '${op}' requires a number, got '${literalAsString(lit)}'`,
					0,
				);
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

function getTag(el: FilterableElement, key: string): string | null {
	const clean = key.startsWith("tags.") ? key.slice(5) : key;
	if (clean === "name" && el.name) return el.name;
	return el.tags?.[clean] ?? null;
}

function regexFromToken(t: Token): RegExp {
	if (t.type === "regex") {
		try {
			return new RegExp(t.value, t.flags ?? "");
		} catch (e) {
			throw new WhereParseError(`invalid regex /${t.value}/: ${(e as Error).message}`, 0);
		}
	}
	return new RegExp(escapeRegex(literalAsString(t)), "i");
}

function literalAsString(t: Token): string {
	switch (t.type) {
		case "lparen":
			return "(";
		case "rparen":
			return ")";
		default:
			return t.value;
	}
}

function literalAsNumber(t: Token): number | null {
	if (t.type === "number") return parseOsmNumber(t.value);
	return parseOsmNumber(literalAsString(t));
}

/** Parse an OSM-style numeric value (may include units like `"42 m"`). Returns null on unparseable input. */
export function parseOsmNumber(raw: string | null): number | null {
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
		if (c === "/") {
			const end = findRegexEnd(s, i + 1);
			if (end === -1) throw new WhereParseError("unterminated regex literal", i);
			const body = s.slice(i + 1, end);
			i = end + 1;
			let flags = "";
			while (i < s.length && /[a-z]/.test(s[i]!)) {
				flags += s[i];
				i++;
			}
			tokens.push({ type: "regex", value: body, flags });
			continue;
		}
		if (c === '"' || c === "'") {
			const end = findStringEnd(s, i + 1, c);
			if (end === -1) throw new WhereParseError(`unterminated string starting at ${i}`, i);
			const body = s.slice(i + 1, end);
			i = end + 1;
			tokens.push({ type: "string", value: body });
			continue;
		}
		const two = s.slice(i, i + 2);
		if (two === "<=" || two === ">=" || two === "!=" || two === "=~" || two === "!~") {
			tokens.push({ type: "op", value: two });
			i += 2;
			continue;
		}
		if (c === "<" || c === ">" || c === "=") {
			tokens.push({ type: "op", value: c });
			i++;
			continue;
		}
		if (/[0-9]/.test(c) || (c === "-" && /[0-9]/.test(s[i + 1] ?? ""))) {
			let j = i + 1;
			while (j < s.length && /[0-9.,\s]/.test(s[j]!)) j++;
			tokens.push({ type: "number", value: s.slice(i, j) });
			i = j;
			continue;
		}
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

/** Filter elements by tag key/value/op predicates. Each tag spec is matched independently (AND). */
export function applyTagsFilter(
	elements: FilterableElement[],
	tags: { key: string; value?: string; op?: string }[],
): FilterableElement[] {
	if (!tags || tags.length === 0) return elements;
	return elements.filter((el) =>
		tags.every((t) => {
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

/** Sort elements by a tag key. Prefix with `-` for descending order. Numeric-aware when values parse as numbers. */
export function applySortBy(elements: FilterableElement[], sortBy: string): FilterableElement[] {
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
		const cmp = av.localeCompare(bv, "en", { numeric: true });
		return desc ? -cmp : cmp;
	});
	return sorted;
}
