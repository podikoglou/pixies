import { MontyRuntimeError, MontySyntaxError, MontyTypingError, MontyError } from "@pydantic/monty";
import {
	findFeaturesHost,
	filterHost,
	spatialJoinHost,
	renderDiagnosisLines,
	type GeocodeResult,
	type FindFeaturesResult,
	type Feature,
	type DisplayData,
	type SpatialPair,
} from "@pixies/core/tools";

/**
 * Pure host-call shapes: kwargs normalizers, summary formatters, and Monty
 * error mapping extracted out of {@link MontyExecutor} so they can be unit-tested
 * in-process — no sandbox startup, no fake Nominatim/Overpass stubs.
 *
 * The normalizer seam is the most-edited part of the host surface: every new
 * host function adds one `normalize*` entry plus a formatter, and each is now
 * exercisable directly rather than only through a full sandbox run.
 *
 * `findFeaturesHost`/`filterHost`/`spatialJoinHost` are imported as values but
 * never called here — they exist only to anchor the `Parameters<typeof …>`
 * return-type annotations (core does not export the param types).
 */

/** Map a thrown Monty error (or plain Error) to a model-facing `{errorType, message}`. Dispatches by `instanceof`: runtime → traceback, syntax/type → concise message, base MontyError → type-msg, plain Error → its message, anything else → String(). */
export function formatMontyError(err: unknown): { errorType: string; message: string } {
	if (err instanceof MontyRuntimeError) {
		return {
			errorType: err.exception.typeName,
			message: err.display("traceback"),
		};
	}
	if (err instanceof MontySyntaxError) {
		return {
			errorType: "SyntaxError",
			message: err.display("type-msg"),
		};
	}
	if (err instanceof MontyTypingError) {
		return {
			errorType: "TypeError",
			message: err.displayDiagnostics("concise"),
		};
	}
	if (err instanceof MontyError) {
		return {
			errorType: err.exception.typeName,
			message: err.display("type-msg"),
		};
	}
	if (err instanceof Error) {
		return { errorType: "RuntimeError", message: err.message };
	}
	return { errorType: "RuntimeError", message: String(err) };
}

/** One-line model-visible summary of a geocode result: name + coordinates, or "no results". */
export function formatGeocodeSummary(query: string, result: GeocodeResult | null): string {
	if (!result) return `geocode("${query}") → no results\n`;
	const name = result.name ?? result.display_name?.split(",")[0] ?? "unknown";
	return `geocode("${query}") → ${name} (${result.lat}, ${result.lon})\n`;
}

/** search summary. Always carries a "(ranked, possibly incomplete)" qualifier so
 *  the model never mistakes a partial ranked answer for an exhaustive one; when
 *  the heuristic cap fires, escalate to "(ranked, incomplete) [capped]". */
export function formatSearchSummary(
	query: string,
	result: { count: number; truncated: boolean; features: Feature[] },
): string {
	const tail = result.truncated
		? `+ (ranked, incomplete) [capped]`
		: ` (ranked, possibly incomplete)`;
	const shown = Math.min(3, result.features.length);
	const names = result.features
		.slice(0, shown)
		.map((f) => f.name ?? f.id)
		.join(", ");
	return `search("${query}") → ${result.count}${tail}\n${shown > 0 ? `  top: ${names}\n` : ""}`;
}

function formatAreaDesc(area: Record<string, unknown> | undefined): string {
	if (!area) return "features-based";
	if (area.place) return `place=${area.place}`;
	if (area.around) return `around=${JSON.stringify(area.around)}`;
	if (area.bounds) return `bounds=${JSON.stringify(area.bounds)}`;
	return "features-based";
}

/** Model-visible summary of a find_features call: a head line (types, area, count,
 *  truncation) followed by either the top-3 feature names or, on 0-results, the
 *  "did you mean?" diagnosis. */
export function formatFindFeaturesSummary(
	params: Record<string, unknown>,
	result: FindFeaturesResult,
): string {
	const types = params.types;
	const areaDesc = formatAreaDesc(params.area as Record<string, unknown> | undefined);
	const typesDesc = Array.isArray(types) ? types.join(", ") : "none";
	const head = `find_features(types=[${typesDesc}], ${areaDesc}) → ${result.count} feature(s)${truncatedSuffix(result)}`;
	if (result.features.length > 0) {
		const names = result.features
			.slice(0, Math.min(3, result.features.length))
			.map((f) => f.name ?? f.id)
			.join(", ");
		return `${head}\n  top: ${names}\n`;
	}
	// 0-results: render the "did you mean?" diagnosis below the head line.
	if (!result.diagnosis) return `${head}\n`;
	const lines = [head, ...renderDiagnosisLines(result.diagnosis).map((l) => `  ${l}`)];
	return `${lines.join("\n")}\n`;
}

function truncatedSuffix(result: FindFeaturesResult): string {
	return result.truncated ? ` (showing ${result.features.length})` : "";
}

/** Describe a runtime value's shape in Python terms, recognizing the envelope. */
export function describeShape(value: unknown): string {
	if (value === null || value === undefined) return "None";
	if (Array.isArray(value)) return "list";
	if (typeof value === "object") {
		const v = value as Record<string, unknown>;
		if ("features" in v && "count" in v) return "FeaturesEnvelope";
		return "dict";
	}
	return typeof value;
}

/**
 * Coerce an argument that must be a `list[Feature]`, throwing a clear,
 * model-actionable error when it isn't. The common mistake is passing a
 * `FeaturesEnvelope` (`find_features`/`search`/`overpass_query` return value)
 * where a bare list is expected:
 *
 *     result = find_features(types=["pharmacy"], area={...})
 *     spatial_join(points=result, ...)   # envelope, not list
 *
 * Previously this silently became `[]` → "0 pairs" with no explanation. The
 * thrown error names the wrong shape and the fix; it surfaces as a RuntimeError
 * the model corrects in one retry.
 */
export function requireFeatureList(value: unknown, name: string): Feature[] {
	if (Array.isArray(value)) return value as Feature[];
	const got = describeShape(value);
	const hint = got === "FeaturesEnvelope" ? ` — use ${name}["features"]` : "";
	throw new Error(`${name} must be a list[Feature], got ${got}${hint}`);
}

/** Coerce raw kwargs from `find_features(...)` into the typed params `findFeaturesHost` expects. */
export function normalizeFindFeaturesParams(
	params: Record<string, unknown>,
): Parameters<typeof findFeaturesHost>[1] {
	return {
		...(Array.isArray(params.types) ? { types: params.types.map(String) } : {}),
		...(Array.isArray(params.tags) ? { tags: params.tags as never } : {}),
		area: normalizeArea(params.area as Record<string, unknown> | undefined),
		...(typeof params.name === "string" ? { name: params.name } : {}),
		...(typeof params.limit === "number" ? { limit: params.limit } : {}),
	};
}

/** Normalize an `area` argument into one of: `{ place }`, `{ bounds }`, `{ around }`, or `{ features }`. Coerces a single-feature object with lat/lon/radius to `{ around }`. */
export function normalizeArea(
	area: Record<string, unknown> | undefined,
): Parameters<typeof findFeaturesHost>[1]["area"] {
	if (!area) throw new Error("area is required");
	if (typeof area.place === "string") return { place: area.place };
	if (area.bounds && typeof area.bounds === "object") {
		const b = area.bounds as Record<string, number>;
		return {
			bounds: { minlat: b.minlat!, minlon: b.minlon!, maxlat: b.maxlat!, maxlon: b.maxlon! },
		};
	}
	if (area.around && typeof area.around === "object") {
		const a = area.around as Record<string, number>;
		return { around: { lat: a.lat!, lon: a.lon!, radius: a.radius! } };
	}
	if (area.features && typeof area.features === "object") {
		const f = area.features as Record<string, unknown>;
		if (f.lat !== undefined && f.lon !== undefined && f.radius !== undefined) {
			return { around: { lat: Number(f.lat), lon: Number(f.lon), radius: Number(f.radius) } };
		}
	}
	if (Array.isArray(area.features)) {
		return { features: area.features as Feature[] };
	}
	throw new Error("area must specify one of: place, bounds, around, features");
}

/** Coerce raw kwargs from `filter(...)` into `FilterParams`. Accepts `sortBy` as an alias for `sort_by`. */
export function normalizeFilterParams(
	params: Record<string, unknown>,
): Parameters<typeof filterHost>[1] {
	return {
		...(typeof params.where === "string" ? { where: params.where } : {}),
		...(Array.isArray(params.tags) ? { tags: params.tags as never } : {}),
		...(typeof params.sort_by === "string" ? { sort_by: params.sort_by } : {}),
		...(typeof params.sortBy === "string" ? { sort_by: params.sortBy } : {}),
		...(typeof params.limit === "number" ? { limit: params.limit } : {}),
		...(typeof params.distinct === "boolean" ? { distinct: params.distinct } : {}),
	};
}

/** Coerce raw kwargs from `spatial_join(...)` into `SpatialJoinParams`, defaulting
 *  operation to "near" and radius to 1000m, shape-guarding points/targets as feature lists. */
export function normalizeSpatialJoinParams(
	params: Record<string, unknown>,
): Parameters<typeof spatialJoinHost>[0] {
	return {
		points: requireFeatureList(params.points, "points"),
		targets: requireFeatureList(params.targets, "targets"),
		operation: params.operation === "nearest" ? "nearest" : "near",
		radius: typeof params.radius === "number" ? params.radius : 1000,
	};
}

/** Coerce raw kwargs from `display(...)` into a `DisplayData` payload, selecting only the recognized display fields. */
export function normalizeDisplayData(params: Record<string, unknown>): DisplayData {
	const data: DisplayData = {};
	if (Array.isArray(params.markers)) {
		data.markers = params.markers as DisplayData["markers"];
	}
	if (Array.isArray(params.features)) {
		data.features = params.features as Feature[];
	}
	if (Array.isArray(params.pairs)) {
		data.pairs = params.pairs as SpatialPair[];
	}
	if (params.bounds && typeof params.bounds === "object") {
		data.bounds = params.bounds as DisplayData["bounds"];
	}
	return data;
}
