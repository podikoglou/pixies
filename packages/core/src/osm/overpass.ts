import { osmFetch } from "./http.ts";

export interface OverpassElement {
	type: "node" | "way" | "relation";
	id: number;
	lat?: number;
	lon?: number;
	center?: { lat: number; lon: number };
	bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number };
	nodes?: number[];
	geometry?: Array<{ lat: number; lon: number }>;
	tags?: Record<string, string>;
}

export interface OverpassResponse {
	version?: number;
	generator?: string;
	elements?: OverpassElement[];
	remark?: string;
}

export interface OverpassConfig {
	baseUrl: string;
	userAgent: string;
	fetch?: typeof globalThis.fetch;
}

export class OverpassClient {
	private readonly baseUrl: string;
	private readonly userAgent: string;
	private readonly fetchFn: typeof globalThis.fetch;

	constructor(config: OverpassConfig) {
		this.baseUrl = config.baseUrl;
		this.userAgent = config.userAgent;
		this.fetchFn = config.fetch ?? globalThis.fetch;
	}

	async query(query: string, parentSignal?: AbortSignal): Promise<OverpassResponse> {
		const res = await osmFetch(this.baseUrl, this.fetchFn, {
			service: "Overpass",
			method: "POST",
			headers: {
				"User-Agent": this.userAgent,
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: `data=${encodeURIComponent(query)}`,
			signal: parentSignal,
		});
		const contentType = res.headers.get("content-type") ?? "";
		if (!contentType.includes("application/json")) {
			throw new Error("Only [out:json] is supported");
		}
		const json = (await res.json()) as OverpassResponse;
		if (json.remark) {
			throw new Error(`Overpass: ${json.remark}`);
		}
		return json;
	}
}
