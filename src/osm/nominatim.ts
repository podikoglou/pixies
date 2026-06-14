import { config } from "./config.ts";

export interface NominatimResult {
	place_id: number;
	lat: string;
	lon: string;
	display_name: string;
	name?: string;
	type?: string;
	class?: string;
	addresstype?: string;
	osm_type?: "node" | "way" | "relation";
	osm_id?: number;
	boundingbox?: [string, string, string, string];
}

export interface SearchOptions {
	limit?: number;
}

export interface ReverseOptions {
	zoom?: number;
}

const RATE_LIMIT_MS = 1100;
let chain: Promise<unknown> = Promise.resolve();
let lastCallTime = 0;

function withRateLimit<T>(fn: () => Promise<T>): Promise<T> {
	const run = chain.then(async () => {
		const elapsed = Date.now() - lastCallTime;
		const wait = RATE_LIMIT_MS - elapsed;
		if (wait > 0) await new Promise((r) => setTimeout(r, wait));
		lastCallTime = Date.now();
		return fn();
	});
	chain = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

function buildUrl(path: string, params: Record<string, string | number | undefined>): URL {
	const url = new URL(`${config.nominatimUrl}${path}`);
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined) url.searchParams.set(key, String(value));
	}
	if (config.contactEmail) url.searchParams.set("email", config.contactEmail);
	return url;
}

async function fetchJson(url: URL, signal?: AbortSignal): Promise<unknown> {
	return withRateLimit(async () => {
		const merged = mergeSignals(signal, AbortSignal.timeout(60000));
		const res = await fetch(url, {
			headers: { "User-Agent": config.userAgent },
			signal: merged,
		});
		if (!res.ok) {
			throw new Error(`Nominatim ${res.status}: ${await res.text()}`);
		}
		return res.json();
	});
}

function mergeSignals(...signals: (AbortSignal | undefined)[]): AbortSignal {
	const controller = new AbortController();
	for (const signal of signals) {
		if (!signal) continue;
		if (signal.aborted) {
			controller.abort();
			break;
		}
		signal.addEventListener("abort", () => controller.abort(), { once: true });
	}
	return controller.signal;
}

export const nominatim = {
	async search(query: string, opts: SearchOptions = {}, signal?: AbortSignal): Promise<NominatimResult[]> {
		const url = buildUrl("/search", {
			q: query,
			format: "jsonv2",
			limit: opts.limit,
			addressdetails: 1,
		});
		const json = await fetchJson(url, signal);
		return json as NominatimResult[];
	},

	async reverse(
		lat: number,
		lon: number,
		opts: ReverseOptions = {},
		signal?: AbortSignal,
	): Promise<NominatimResult | null> {
		const url = buildUrl("/reverse", {
			lat,
			lon,
			format: "jsonv2",
			zoom: opts.zoom,
			addressdetails: 1,
		});
		const json = await fetchJson(url, signal);
		const result = json as NominatimResult | { error?: string };
		if ("error" in result && result.error) {
			throw new Error(`Nominatim: ${result.error}`);
		}
		return result as NominatimResult;
	},
};
