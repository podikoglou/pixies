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
import { CodeExecutionError } from "@pixies/core";
import {
	geocodeHost,
	reverseGeocodeHost,
	findFeaturesHost,
	filterHost,
	spatialJoinHost,
	overpassQueryHost,
	type HostContext,
	type DisplayData,
	type Feature,
	type GeocodeResult,
	type FindFeaturesResult,
	type SpatialPair,
} from "@pixies/core/tools";
import type { CodeExecutor, CodeExecutionSuccess } from "@pixies/core";

export interface MontyExecutorOptions {
	nominatim: NominatimClient;
	overpass: OverpassClient;
	limits?: ResourceLimits;
}

const DEFAULT_LIMITS: ResourceLimits = {
	maxDurationSecs: 30,
	maxMemory: 64 * 1024 * 1024,
	maxRecursionDepth: 100,
};

/**
 * Per-conversation Monty executor with variable persistence.
 *
 * v0.0.18 has no REPL-with-external-functions API (`MontySession.feedRun`
 * exists on main but is unpublished). State persistence is achieved by
 * prepending previous code snippets so variables exist in scope, with
 * external function call results cached so replay is instant (no network).
 *
 * A `__pixies_replay_end__()` marker is injected between replayed and new
 * code to toggle stdout suppression and cache lookups.
 */
export class MontyExecutor implements CodeExecutor {
	private readonly nominatim: NominatimClient;
	private readonly overpass: OverpassClient;
	private readonly limits: ResourceLimits;
	private readonly codeHistory: string[] = [];
	private readonly callCache = new Map<string, unknown>();

	constructor(opts: MontyExecutorOptions) {
		this.nominatim = opts.nominatim;
		this.overpass = opts.overpass;
		this.limits = opts.limits ?? DEFAULT_LIMITS;
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
		const stdoutParts: string[] = [];
		const displays: DisplayData[] = [];

		const ctx: HostContext = {
			nominatim: this.nominatim,
			overpass: this.overpass,
			signal: options.signal,
		};

		const printCallback = (_stream: string, text: string) => {
			if (!state.isReplaying) stdoutParts.push(text);
		};

		const externalFunctions = this.buildExternalFunctions(
			ctx,
			(text) => {
				if (!state.isReplaying) stdoutParts.push(text);
			},
			(data) => {
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
				stdout: stdoutParts.join(""),
				displays,
			});
		} catch (err) {
			const stdout = stdoutParts.join("");
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
				return result;
			},

			filter: (...args: unknown[]) => {
				const features = (Array.isArray(args[0]) ? args[0] : []) as Feature[];
				const kwargs = (args[args.length - 1] ?? {}) as Record<string, unknown>;
				const result = filterHost(features, normalizeFilterParams(kwargs));
				print(
					`filter(${features.length} features, where=${kwargs.where ?? "none"}) → ${result.length} feature(s)\n`,
				);
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
				print(`overpass_query() → ${result.count} element(s)\n`);
				return result;
			},

			haversine: (...args: unknown[]) => {
				const a = (args[0] ?? {}) as Record<string, unknown>;
				const b = (args[1] ?? {}) as Record<string, unknown>;
				const lat1 = Number(a.lat);
				const lon1 = Number(a.lon);
				const lat2 = Number(b.lat);
				const lon2 = Number(b.lon);
				const R = 6_371_000;
				const toRad = (d: number) => (d * Math.PI) / 180;
				const dLat = toRad(lat2 - lat1);
				const dLon = toRad(lon2 - lon1);
				const x =
					Math.sin(dLat / 2) ** 2 +
					Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
				return Math.round(R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x)));
			},

			bounds_of: (...args: unknown[]) => {
				const features = (Array.isArray(args[0]) ? args[0] : []) as Feature[];
				let minlat = Infinity;
				let minlon = Infinity;
				let maxlat = -Infinity;
				let maxlon = -Infinity;
				let seen = 0;
				for (const f of features) {
					if (f.lat === undefined || f.lon === undefined) continue;
					seen++;
					if (f.lat < minlat) minlat = f.lat;
					if (f.lat > maxlat) maxlat = f.lat;
					if (f.lon < minlon) minlon = f.lon;
					if (f.lon > maxlon) maxlon = f.lon;
				}
				if (seen === 0) return null;
				return { minlat, minlon, maxlat, maxlon };
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

		const cacheKey = JSON.stringify([snapshot.functionName, snapshot.args, snapshot.kwargs]);
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
			result = fn(...snapshot.args, snapshot.kwargs);
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

		opts.callCache.set(cacheKey, result);
		progress = snapshot.resume({ returnValue: result });
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

function formatFindFeaturesSummary(
	params: Record<string, unknown>,
	result: FindFeaturesResult,
): string {
	const types = params.types;
	const area = params.area as Record<string, unknown> | undefined;
	const areaDesc = area?.place
		? `place=${area.place}`
		: area?.around
			? `around=${JSON.stringify(area.around)}`
			: area?.bounds
				? `bounds=${JSON.stringify(area.bounds)}`
				: "features-based";
	const typesDesc = Array.isArray(types) ? types.join(", ") : "none";
	const shown = Math.min(3, result.features.length);
	const names = result.features
		.slice(0, shown)
		.map((f) => f.name ?? f.id)
		.join(", ");
	const relaxed = result.relaxed ? (result.note ? ` [${result.note}]` : " [relaxed]") : "";
	return `find_features(types=[${typesDesc}], ${areaDesc}) → ${result.count} feature(s)${truncated_suffix(result)}${relaxed}\n${shown > 0 ? `  top: ${names}\n` : ""}`;
}

function truncated_suffix(result: FindFeaturesResult): string {
	return result.truncated ? ` (showing ${result.features.length})` : "";
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
		points: (Array.isArray(params.points) ? params.points : []) as Feature[],
		targets: (Array.isArray(params.targets) ? params.targets : []) as Feature[],
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
