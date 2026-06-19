import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Result, matchErrorPartial } from "better-result";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { NominatimClient } from "../osm/nominatim.ts";
import { OSM_SERVER_BUSY_MESSAGE } from "../osm/http.ts";
import { ToolAbortedError } from "../errors.ts";
import { formatNominatimResult, nominatimResultToData } from "../osm/format.ts";
import {
	GeocodeToolDetailsSchema,
	type GeocodeResultEntry,
	type GeocodeToolDetails,
} from "./schemas.ts";
import type { ToolProgress } from "./progress.ts";
import type { ToolModule } from "./tool-module.ts";
import { textResult, formatContentLines } from "./tool-helpers.ts";

const schema = Type.Object({
	query: Type.String({
		description: "Free-form place query, e.g. 'Berlin', '123 Main St, London', 'Eiffel Tower'",
	}),
	limit: Type.Optional(Type.Number({ description: "Max results (Nominatim max 40, default 10)" })),
});

export function createGeocodeTool(
	nominatim: NominatimClient,
): AgentTool<typeof schema, ToolProgress | GeocodeToolDetails | { busy: true }> {
	return {
		name: "geocode",
		label: "Geocode",
		description:
			"Geocode a place name or address to coordinates and OSM metadata using Nominatim. Returns ranked matches with display_name, lat/lon, osm_type/osm_id, and category. Use for resolving place names to coordinates before running an Overpass query.",
		parameters: schema,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate) {
			if (signal?.aborted) throw new ToolAbortedError({ message: "Operation aborted" });
			const result = await Result.gen(async function* () {
				const results = yield* Result.await(
					nominatim.search(params.query, { limit: params.limit }, signal, {
						onProgress: (progress) => onUpdate?.({ content: [], details: progress }),
					}),
				);
				if (results.length === 0) {
					return Result.ok({
						...textResult("No results."),
						details: { top: "no results", data: [] },
					});
				}
				const data = results.map(nominatimResultToData);
				const top = results[0];
				if (!top) throw new Error("No top result");
				const topName = top.name || top.display_name?.split(",")[0] || "unknown";
				const text = formatContentLines(results, formatNominatimResult);
				return Result.ok({
					...textResult(text),
					details: { top: `${topName} (${top.lat},${top.lon})`, data },
				});
			});
			if (Result.isOk(result)) return result.value;
			// OSM-busy → non-error result (do not retry); everything else re-throws
			// so the agent marks the tool call `isError: true` (issue #109).
			return matchErrorPartial(
				result.error,
				{
					OsmBusy: () => ({
						...textResult(OSM_SERVER_BUSY_MESSAGE),
						details: { busy: true, top: "osm server busy", data: [] },
					}),
				},
				(err) => {
					throw err;
				},
			);
		},
	};
}

export const geocodeModule: ToolModule<{ kind: "geocode"; entries: GeocodeResultEntry[] }> = {
	factory: (clients) => createGeocodeTool(clients.nominatim),
	detailsSchema: GeocodeToolDetailsSchema,
	parse: (details) => {
		if (!Value.Check(GeocodeToolDetailsSchema, details)) return null;
		return { kind: "geocode", entries: details.data };
	},
	summarize: (result) => {
		const top = result.entries[0];
		if (!top) return null;
		const name = top.name || top.displayName?.split(",")[0] || "unknown";
		return `${name} (${top.lat},${top.lon})`;
	},
};
