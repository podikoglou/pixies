import { Monty, MontyComplete, MontySnapshot, MontyNameLookup } from "@pydantic/monty";
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
	profileHost,
	formatProfileSummary,
	type HostContext,
	type DisplayData,
} from "@pixies/core/tools";
import type { CodeExecutor, CodeExecutionSuccess, PrimitiveTraceEntry } from "@pixies/core";
import {
	formatMontyError,
	formatGeocodeSummary,
	formatSearchSummary,
	formatFindFeaturesSummary,
	normalizeFindFeaturesParams,
	normalizeFilterParams,
	normalizeSpatialJoinParams,
	normalizeDisplayData,
	requireFeatureList,
} from "./host-call-shapes.ts";
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
		const trace: PrimitiveTraceEntry[] = [];

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
				trace,
			});

			this.codeHistory.push(code);
			return Result.ok({
				summary: summaryParts.join(""),
				stdout: userStdout.finish(),
				displays,
				trace,
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
		trace: PrimitiveTraceEntry[];
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
		const start = Date.now();
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
		} finally {
			opts.trace.push({ name: snapshot.functionName, duration_ms: Date.now() - start });
		}

		const plainResult = deepToPlainObject(result);
		opts.callCache.set(cacheKey, plainResult);
		progress = snapshot.resume({ returnValue: plainResult });
	}
}
