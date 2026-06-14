import { osmFetch } from "./http.ts";

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

export interface RateLimitCallbacks {
	onQueued?: () => void;
	onStart?: () => void;
}

export interface NominatimConfig {
	baseUrl: string;
	contactEmail?: string;
	userAgent: string;
	fetch?: typeof globalThis.fetch;
}

const RATE_LIMIT_MS = 1100;

export class NominatimClient {
	private readonly baseUrl: string;
	private readonly contactEmail?: string;
	private readonly userAgent: string;
	private readonly fetchFn: typeof globalThis.fetch;
	private chain: Promise<unknown> = Promise.resolve();
	private lastCallTime = 0;

	constructor(config: NominatimConfig) {
		this.baseUrl = config.baseUrl;
		this.contactEmail = config.contactEmail;
		this.userAgent = config.userAgent;
		this.fetchFn = config.fetch ?? globalThis.fetch;
	}

	private withRateLimit<T>(
		fn: () => Promise<T>,
		signal?: AbortSignal,
		opts: RateLimitCallbacks = {},
	): Promise<T> {
		const run = this.chain.then(async () => {
			const elapsed = Date.now() - this.lastCallTime;
			const wait = RATE_LIMIT_MS - elapsed;
			if (wait > 0) {
				opts.onQueued?.();
				await new Promise<void>((resolve, reject) => {
					const timer = setTimeout(resolve, wait);
					signal?.addEventListener(
						"abort",
						() => {
							clearTimeout(timer);
							reject(signal.reason ?? new Error("Aborted"));
						},
						{ once: true },
					);
				});
			}
			this.lastCallTime = Date.now();
			opts.onStart?.();
			return fn();
		});
		this.chain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private buildUrl(path: string, params: Record<string, string | number | undefined>): URL {
		const url = new URL(`${this.baseUrl}${path}`);
		for (const [key, value] of Object.entries(params)) {
			if (value !== undefined) url.searchParams.set(key, String(value));
		}
		if (this.contactEmail) url.searchParams.set("email", this.contactEmail);
		return url;
	}

	private async fetchJson(
		url: URL,
		signal?: AbortSignal,
		opts: RateLimitCallbacks = {},
	): Promise<unknown> {
		return this.withRateLimit(
			async () => {
				const res = await osmFetch(url, this.fetchFn, {
					service: "Nominatim",
					headers: { "User-Agent": this.userAgent },
					signal,
				});
				return res.json();
			},
			signal,
			opts,
		);
	}

	async search(
		query: string,
		opts: SearchOptions = {},
		signal?: AbortSignal,
		callbacks: RateLimitCallbacks = {},
	): Promise<NominatimResult[]> {
		const url = this.buildUrl("/search", {
			q: query,
			format: "jsonv2",
			limit: opts.limit,
			addressdetails: 1,
		});
		const json = await this.fetchJson(url, signal, callbacks);
		return json as NominatimResult[];
	}

	async reverse(
		lat: number,
		lon: number,
		opts: ReverseOptions = {},
		signal?: AbortSignal,
		callbacks: RateLimitCallbacks = {},
	): Promise<NominatimResult | null> {
		const url = this.buildUrl("/reverse", {
			lat,
			lon,
			format: "jsonv2",
			zoom: opts.zoom,
			addressdetails: 1,
		});
		const json = await this.fetchJson(url, signal, callbacks);
		const result = json as NominatimResult | { error?: string };
		if ("error" in result && result.error) {
			throw new Error(`Nominatim: ${result.error}`);
		}
		return result as NominatimResult;
	}
}
