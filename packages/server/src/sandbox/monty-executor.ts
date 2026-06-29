import {
	Monty,
	MontyComplete,
	MontySnapshot,
	MontyNameLookup,
	MontyRuntimeError,
	MontySyntaxError,
	MontyTypingError,
	MontyError,
} from "@pydantic/monty";
import type { ResourceLimits } from "@pydantic/monty";
import { Result, type NominatimClient, type OverpassClient } from "@pixies/core";
import { CodeExecutionError, mergeSignals } from "@pixies/core";
import {
	geocodeHost,
	reverseGeocodeHost,
	findFeaturesHost,
	filterHost,
	spatialJoinHost,
	overpassQueryHost,
	searchHost,
	haversineMeters,
	computeBounds,
	renderDiagnosisLines,
	profileHost,
	formatProfileSummary,
	type HostContext,
	type DisplayData,
	type Feature,
	type GeocodeResult,
	type FindFeaturesResult,
	type SpatialPair,
} from "@pixies/core/tools";
import type { CodeExecutor, CodeExecutionSuccess } from "@pixies/core";
import { StdoutCollector } from "./stdout-collector.ts";

export interface MontyExecutorOptions {
	nominatim: NominatimClient;
	overpass: OverpassClient;
	limits?: ResourceLimits;
	/** Hard wall-clock timeout (seconds) for the entire execute() call, including
	 *  host function I/O. Defaults to 5s. Aborted executions surface as a
	 *  CodeExecutionError with "TimeoutError". */
	maxWallClockSecs?: number;
}

const DEFAULT_LIMITS: ResourceLimits = {
	maxDurationSecs: 30,
	maxMemory: 64 * 1024 * 1024,
	maxRecursionDepth: 100,
};

/**
 * Per-cell char budget on the model's own `print()` output. Host-function
 * summaries are server-authored and unbounded; this bounds only the model's
 * stdout (which tends to be `print(features)` floods). See {@link StdoutCollector}.
 */
const DEFAULT_USER_STDOUT_BUDGET = 1500;

/**
 * Per-conversation Monty executor with variable persistence.
 *
 * `@pydantic/monty` has no session/REPL API for incremental execution, so
 * state persistence is achieved by prepending previous code snippets so
 * variables exist in scope. External function call results are cached so
 * replay is instant (no network). A `__pixies_replay_end__()` marker is
 * injected between replayed and new code to toggle stdout suppression and
 * cache lookups.
 */
export class MontyExecutor implements CodeExecutor {
	private readonly nominatim: NominatimClient;
	private readonly overpass: OverpassClient;
	private readonly limits: ResourceLimits;
	private readonly maxWallClockSecs: number;
	private readonly codeHistory: string[] = [];
	private readonly callCache = new Map<string, unknown>();

	constructor(opts: MontyExecutorOptions) {
		this.nominatim = opts.nominatim;
		this.overpass = opts.overpass;
		this.limits = opts.limits ?? DEFAULT_LIMITS;
		this.maxWallClockSecs = opts.maxWallClockSecs ?? 5;
	}

	async execute(
		code: string,
		options: {
			signal?: AbortSignal;
			onDisplay?: (data: DisplayData) => void;
			onProgress?: (message: string) => void;
		},
	): Promise<Result<CodeExecutionSuccess, CodeExecutionError>> {
		const isFirstCall = this.codeHistory.length === 0;
		const fullCode = isFirstCall
			? code
			: `${this.codeHistory.join("\n")}\n__pixies_replay_end__()\n${code}`;

		const state = { isReplaying: !isFirstCall };
		// Two channels, split at the executor (Principle 3): curated host-function
		// summaries (model-visible, server-authored, unbounded) and the model's
		// own print() (bounded — the model tends to print(features) and flood its
		// context). The model's print never re-enters unbounded; StdoutCollector
		// caps it per cell and appends a marker steering to profile()/filter().
		const summaryParts: string[] = [];
		const userStdout = new StdoutCollector(DEFAULT_USER_STDOUT_BUDGET);
		const displays: DisplayData[] = [];

		const wallSignal = mergeSignals(
			options.signal,
			AbortSignal.timeout(this.maxWallClockSecs * 1000),
		);

		const ctx: HostContext = {
			nominatim: this.nominatim,
			overpass: this.overpass,
			signal: wallSignal,
		};

		const printCallback = (_stream: string, text: string) => {
			if (!state.isReplaying) userStdout.push(text);
		};

		const externalFunctions = this.buildExternalFunctions(
			ctx,
			(text) => {
				if (!state.isReplaying) summaryParts.push(text);
			},
			(data) => {
				if (state.isReplaying) return;
				displays.push(data);
				options.onDisplay?.(data);
			},
		);

		try {
			const monty = new Monty(fullCode, { scriptName: "pixies.py" });
			await runMontyLoop(monty, {
				externalFunctions,
				limits: this.limits,
				printCallback,
				callCache: this.callCache,
				state,
			});

			this.codeHistory.push(code);
			return Result.ok({
				summary: summaryParts.join(""),
				stdout: userStdout.finish(),
				displays,
			});
		} catch (err) {
			// On error, surface both channels as pre-error context so the model
			// can see what ran before it failed (summaries + its own prints).
			const summary = summaryParts.join("");
			const stdout = `${summary}${userStdout.finish()}`;
			const { errorType, message } = formatMontyError(err);
			return Result.err(
				new CodeExecutionError({
					stdout,
					errorType,
					message: stdout ? `${stdout}\n\n${errorType}: ${message}` : `${errorType}: ${message}`,
				}),
			);
		}
	}

	private buildExternalFunctions(
		ctx: HostContext,
		print: (text: string) => void,
		onDisplay: (data: DisplayData) => void,
	): Record<string, (...args: unknown[]) => unknown> {
		const fns: Record<string, (...args: unknown[]) => unknown> = {
			geocode: async (...args: unknown[]) => {
				const query = String(args[0] ?? "");
				const result = await geocodeHost(ctx, query);
				print(formatGeocodeSummary(query, result));
				return result;
			},

			reverse_geocode: async (...args: unknown[]) => {
				const lat = Number(args[0]);
				const lon = Number(args[1]);
				const results = await reverseGeocodeHost(ctx, lat, lon);
				print(`reverse_geocode(${lat}, ${lon}) → ${results.length} result(s)\n`);
				return results;
			},

			find_features: async (...args: unknown[]) => {
				const kwargs = (args[args.length - 1] ?? {}) as Record<string, unknown>;
				const result = await findFeaturesHost(ctx, normalizeFindFeaturesParams(kwargs));
				print(formatFindFeaturesSummary(kwargs, result));
				if (result.features.length > 0) {
					onDisplay({ features: result.features });
				}
				return result;
			},

			filter: (...args: unknown[]) => {
				const features = requireFeatureList(args[0], "features");
				const kwargs = (args[args.length - 1] ?? {}) as Record<string, unknown>;
				const result = filterHost(features, normalizeFilterParams(kwargs));
				print(
					`filter(${features.length} features, where=${kwargs.where ?? "none"}) → ${result.length} feature(s)\n`,
				);
				return result;
			},

			profile: (...args: unknown[]) => {
				const features = requireFeatureList(args[0], "features");
				const kwargs = (args[args.length - 1] ?? {}) as Record<string, unknown>;
				const maxTags = typeof kwargs.max_tags === "number" ? kwargs.max_tags : 12;
				const result = profileHost(features, maxTags);
				print(formatProfileSummary(result));
				return result;
			},

			spatial_join: (...args: unknown[]) => {
				const kwargs = (args[args.length - 1] ?? {}) as Record<string, unknown>;
				const result = spatialJoinHost(normalizeSpatialJoinParams(kwargs));
				const best = result[0]?.distance;
				print(
					`spatial_join(${kwargs.operation}, ${kwargs.radius}m) → ${result.length} pair(s)` +
						(best !== undefined ? ` (best: ${best}m)\n` : "\n"),
				);
				if (result.length > 0) {
					onDisplay({ pairs: result });
				}
				return result;
			},

			display: (...args: unknown[]) => {
				const kwargs = (args[args.length - 1] ?? {}) as Record<string, unknown>;
				const data = normalizeDisplayData(kwargs);
				onDisplay(data);
				print("display() → map updated\n");
				return null;
			},

			overpass_query: async (...args: unknown[]) => {
				const query = String(args[0] ?? "");
				const result = await overpassQueryHost(ctx, query);
				print(`overpass_query() → ${result.count}\n`);
				if (result.features.length > 0) {
					onDisplay({ features: result.features });
				}
				return result;
			},

			search: async (...args: unknown[]) => {
				const query = String(args[0] ?? "");
				const kwargs = (args[args.length - 1] ?? {}) as Record<string, unknown>;
				const limit = typeof kwargs.limit === "number" ? kwargs.limit : 40;
				const result = await searchHost(ctx, query, limit);
				print(formatSearchSummary(query, result));
				if (result.features.length > 0) {
					onDisplay({ features: result.features });
				}
				return result;
			},

			haversine: (...args: unknown[]) => {
				const a = (args[0] ?? {}) as Record<string, unknown>;
				const b = (args[1] ?? {}) as Record<string, unknown>;
				return Math.round(
					haversineMeters(Number(a.lat), Number(a.lon), Number(b.lat), Number(b.lon)),
				);
			},

			bounds_of: (...args: unknown[]) => {
				const features = requireFeatureList(args[0], "features");
				return computeBounds(features);
			},
		};
		return fns;
	}
}

/**
 * Execute a Monty instance with async external function support.
 *
 * Replacement for Monty's `runMontyAsync` that fixes a critical bug: the
 * upstream function puts `snapshot.resume({ returnValue })` inside the same
 * try-catch as the external function call. If `resume()` throws (e.g. it
 * can't serialize the return value), the catch tries to re-resume with
 * `exception: { type: err.name }` — but `err.name` is `'MontyRuntimeError'`,
 * which is not a valid Python exception type, producing the useless
 * "Invalid exception type: 'MontyRuntimeError'" message.
 *
 * This loop keeps `resume()` outside the external-function try-catch, so
 * resume errors propagate directly. It also handles replay caching: during
 * replay, cached results are returned instantly without calling the real
 * function, and `display()` / `__pixies_replay_end__()` are handled specially.
 */
/**
 * Deep-convert Monty types (Map for dict, array-with-__tuple__ for tuple) into
 * plain JS objects and arrays so external functions receive native shapes.
 *
 * Monty's `monty_to_js` serializes Python dicts as JS `Map` instances and
 * tuples as arrays with a `__tuple__` marker. Every external-function caller
 * would otherwise need to defend against Maps — `normalizeDisplayData`,
 * `normalizeArea`, cache-key construction, and the web client's marker
 * resolution all expect plain objects. This one conversion avoids poisoning
 * every consumer.
 */
function deepToPlainObject(value: unknown): unknown {
	if (value instanceof Map) {
		const obj: Record<string, unknown> = {};
		for (const [k, v] of value) {
			obj[k] = deepToPlainObject(v);
		}
		return obj;
	}
	if (Array.isArray(value)) {
		// Tuple marker: plain array (no __tuple__ property, no special treatment).
		return value.map(deepToPlainObject);
	}
	if (value !== null && typeof value === "object") {
		const obj: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			if (k === "__tuple__") continue;
			obj[k] = deepToPlainObject(v);
		}
		return obj;
	}
	return value;
}

async function runMontyLoop(
	monty: Monty,
	opts: {
		externalFunctions: Record<string, (...args: unknown[]) => unknown>;
		limits?: ResourceLimits;
		printCallback?: (stream: string, text: string) => void;
		callCache: Map<string, unknown>;
		state: { isReplaying: boolean };
	},
): Promise<void> {
	let progress: MontySnapshot | MontyNameLookup | MontyComplete = monty.start({
		limits: opts.limits,
		printCallback: opts.printCallback,
	});

	while (!(progress instanceof MontyComplete)) {
		if (progress instanceof MontyNameLookup) {
			const fn = opts.externalFunctions[progress.variableName];
			progress = fn ? progress.resume({ value: fn }) : progress.resume();
			continue;
		}

		const snapshot = progress as MontySnapshot;

		if (snapshot.functionName === "__pixies_replay_end__") {
			opts.state.isReplaying = false;
			progress = snapshot.resume({ returnValue: null });
			continue;
		}

		if (opts.state.isReplaying && snapshot.functionName === "display") {
			progress = snapshot.resume({ returnValue: null });
			continue;
		}

		const plainArgs = deepToPlainObject(snapshot.args);
		const plainKwargs = deepToPlainObject(snapshot.kwargs);
		const cacheKey = JSON.stringify([snapshot.functionName, plainArgs, plainKwargs]);
		if (opts.state.isReplaying && opts.callCache.has(cacheKey)) {
			progress = snapshot.resume({ returnValue: opts.callCache.get(cacheKey) });
			continue;
		}

		const fn = opts.externalFunctions[snapshot.functionName];
		if (!fn) {
			progress = snapshot.resume({
				exception: {
					type: "NameError",
					message: `name '${snapshot.functionName}' is not defined`,
				},
			});
			continue;
		}

		let result: unknown;
		try {
			result = fn(...(plainArgs as unknown[]), plainKwargs);
			if (result && typeof (result as Promise<unknown>).then === "function") {
				result = await result;
			}
		} catch (error) {
			progress = snapshot.resume({
				exception: {
					type: "RuntimeError",
					message: error instanceof Error ? error.message : String(error),
				},
			});
			continue;
		}

		const plainResult = deepToPlainObject(result);
		opts.callCache.set(cacheKey, plainResult);
		progress = snapshot.resume({ returnValue: plainResult });
	}
}

function formatMontyError(err: unknown): { errorType: string; message: string } {
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

function formatGeocodeSummary(query: string, result: GeocodeResult | null): string {
	if (!result) return `geocode("${query}") → no results\n`;
	const name = result.name ?? result.display_name?.split(",")[0] ?? "unknown";
	return `geocode("${query}") → ${name} (${result.lat}, ${result.lon})\n`;
}

/** search summary. Always carries a "(ranked, possibly incomplete)" qualifier so
 *  the model never mistakes a partial ranked answer for an exhaustive one; when
 *  the heuristic cap fires, escalate to "(ranked, incomplete) [capped]". */
function formatSearchSummary(
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

function formatFindFeaturesSummary(
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
function requireFeatureList(value: unknown, name: string): Feature[] {
	if (Array.isArray(value)) return value as Feature[];
	const got = describeShape(value);
	const hint = got === "FeaturesEnvelope" ? ` — use ${name}["features"]` : "";
	throw new Error(`${name} must be a list[Feature], got ${got}${hint}`);
}

/** Describe a runtime value's shape in Python terms, recognizing the envelope. */
function describeShape(value: unknown): string {
	if (value === null || value === undefined) return "None";
	if (Array.isArray(value)) return "list";
	if (typeof value === "object") {
		const v = value as Record<string, unknown>;
		if ("features" in v && "count" in v) return "FeaturesEnvelope";
		return "dict";
	}
	return typeof value;
}

function normalizeFindFeaturesParams(
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
function normalizeArea(
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

function normalizeFilterParams(params: Record<string, unknown>): Parameters<typeof filterHost>[1] {
	return {
		...(typeof params.where === "string" ? { where: params.where } : {}),
		...(Array.isArray(params.tags) ? { tags: params.tags as never } : {}),
		...(typeof params.sort_by === "string" ? { sort_by: params.sort_by } : {}),
		...(typeof params.sortBy === "string" ? { sort_by: params.sortBy } : {}),
		...(typeof params.limit === "number" ? { limit: params.limit } : {}),
		...(typeof params.distinct === "boolean" ? { distinct: params.distinct } : {}),
	};
}

function normalizeSpatialJoinParams(
	params: Record<string, unknown>,
): Parameters<typeof spatialJoinHost>[0] {
	return {
		points: requireFeatureList(params.points, "points"),
		targets: requireFeatureList(params.targets, "targets"),
		operation: params.operation === "nearest" ? "nearest" : "near",
		radius: typeof params.radius === "number" ? params.radius : 1000,
	};
}

function normalizeDisplayData(params: Record<string, unknown>): DisplayData {
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
