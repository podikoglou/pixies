import { Result, matchErrorPartial } from "better-result";
import { Type } from "typebox";
import type { NominatimClient } from "../clients/nominatim.ts";
import { formatNominatimResult } from "../clients/nominatim.ts";
import { ToolAbortedError } from "../errors.ts";
import { NOMINATIM_BUSY_MESSAGE } from "./busy-message.ts";
import { nominatimResultToData } from "./geocode-entry.ts";
import {
	GeocodeToolDetailsSchema,
	type GeocodeResultEntry,
	type GeocodeToolDetails,
} from "./schemas.ts";
import type { ToolProgress } from "./progress.ts";
import { defineTool, parseSchema } from "./tool-module.ts";
import { textResult, formatContentLines } from "./content.ts";

const schema = Type.Object({
	query: Type.String({
		description: "Free-form place query, e.g. 'Berlin', '123 Main St, London', 'Eiffel Tower'",
	}),
	limit: Type.Optional(Type.Number({ description: "Max results (Nominatim max 40, default 10)" })),
});

export const geocodeModule = defineTool<
	{ kind: "geocode"; entries: GeocodeResultEntry[] },
	{ nominatim: NominatimClient },
	typeof schema,
	ToolProgress | GeocodeToolDetails | { busy: true }
>({
	name: "geocode",
	label: "Geocode",
	description:
		"Geocode a place name or address to coordinates and OSM metadata using Nominatim. Returns ranked matches with display_name, lat/lon, osm_type/osm_id, and category. Use for resolving place names to coordinates before running an Overpass query.",
	parameters: schema,
	executionMode: "sequential",
	detailsSchema: GeocodeToolDetailsSchema,
	parse: parseSchema(GeocodeToolDetailsSchema, (d) => ({ kind: "geocode", entries: d.data })),
	execute: async ({ nominatim }, _toolCallId, params, signal, onUpdate) => {
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
					details: { data: [] },
				});
			}
			const data = results.map(nominatimResultToData);
			const text = formatContentLines(results, formatNominatimResult);
			return Result.ok({
				...textResult(text),
				details: { data },
			});
		});
		if (Result.isOk(result)) return result.value;
		// Nominatim-busy → non-error result (do not retry); everything else
		// re-throws so the agent marks the tool call `isError: true`.
		return matchErrorPartial(
			result.error,
			{
				NominatimBusy: () => ({
					...textResult(NOMINATIM_BUSY_MESSAGE),
					details: { busy: true, data: [] },
				}),
			},
			(err) => {
				throw err;
			},
		);
	},
});
