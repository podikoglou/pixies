import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Result, matchErrorPartial } from "better-result";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { NominatimClient } from "../osm/nominatim.ts";
import { OSM_SERVER_BUSY_MESSAGE } from "../osm/http.ts";
import { ToolAbortedError } from "../errors.ts";
import { formatNominatimResult, nominatimResultToData } from "../osm/format.ts";
import {
	ReverseGeocodeToolDetailsSchema,
	type GeocodeResultEntry,
	type ReverseGeocodeToolDetails,
} from "./schemas.ts";
import type { ToolProgress } from "./progress.ts";
import type { ToolModule } from "./tool-module.ts";
import { textResult } from "./content.ts";

const schema = Type.Object({
	lat: Type.Number({ description: "Latitude" }),
	lon: Type.Number({ description: "Longitude" }),
	zoom: Type.Optional(
		Type.Number({
			description:
				"Address granularity 0-18 (18=building, 14=street, 10=suburb, 3=country). Default 18.",
		}),
	),
});

export function createReverseGeocodeTool(
	nominatim: NominatimClient,
): AgentTool<typeof schema, ToolProgress | ReverseGeocodeToolDetails | { busy: true } | undefined> {
	return {
		name: "reverse_geocode",
		label: "Reverse geocode",
		description:
			"Reverse geocode coordinates to a place name and address using Nominatim. Returns display_name, address breakdown, and OSM element reference. Use for 'what is at these coordinates' queries.",
		parameters: schema,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate) {
			if (signal?.aborted) throw new ToolAbortedError({ message: "Operation aborted" });
			const result = await Result.gen(async function* () {
				const result = yield* Result.await(
					nominatim.reverse(params.lat, params.lon, { zoom: params.zoom }, signal, {
						onProgress: (progress) => onUpdate?.({ content: [], details: progress }),
					}),
				);
				if (!result || !result.display_name) {
					return Result.ok({
						...textResult("No results."),
						details: undefined,
					});
				}
				return Result.ok({
					...textResult(formatNominatimResult(result)),
					details: { data: nominatimResultToData(result) },
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
						details: { busy: true },
					}),
				},
				(err) => {
					throw err;
				},
			);
		},
	};
}

export const reverseGeocodeModule: ToolModule<{
	kind: "reverse_geocode";
	entry: GeocodeResultEntry;
}> = {
	factory: (clients) => createReverseGeocodeTool(clients.nominatim),
	detailsSchema: ReverseGeocodeToolDetailsSchema,
	parse: (details) => {
		if (!Value.Check(ReverseGeocodeToolDetailsSchema, details)) return null;
		return { kind: "reverse_geocode", entry: details.data };
	},
	summarize: (result) => result.entry.name,
};
