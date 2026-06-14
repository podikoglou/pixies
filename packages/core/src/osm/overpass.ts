import { config } from "./config.ts";
import { mergeSignals } from "./signal.ts";

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

export const overpass = {
	async query(query: string, parentSignal?: AbortSignal): Promise<OverpassResponse> {
		const signal = mergeSignals(parentSignal, AbortSignal.timeout(60000));
		const res = await fetch(config.overpassUrl, {
			method: "POST",
			headers: {
				"User-Agent": config.userAgent,
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: `data=${encodeURIComponent(query)}`,
			signal,
		});
		if (!res.ok) {
			throw new Error(`Overpass ${res.status}: ${await res.text()}`);
		}
		const contentType = res.headers.get("content-type") ?? "";
		if (!contentType.includes("application/json")) {
			throw new Error("Only [out:json] is supported");
		}
		const json = (await res.json()) as OverpassResponse;
		if (json.remark) {
			throw new Error(`Overpass: ${json.remark}`);
		}
		return json;
	},
};
