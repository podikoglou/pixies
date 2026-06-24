import { Result, matchErrorPartial } from "better-result";
import { Type } from "typebox";
import type { OverpassClient } from "../osm/overpass.ts";
import { OSM_SERVER_BUSY_MESSAGE } from "../osm/http.ts";
import { ToolAbortedError } from "../errors.ts";
import { formatElement, overpassElementToData } from "../osm/format.ts";
import {
	QueryOsmToolDetailsSchema,
	type OverpassResultEntry,
	type QueryOsmToolDetails,
} from "./schemas.ts";
import type { ToolProgress } from "./progress.ts";
import { defineTool, parseSchema } from "./tool-module.ts";
import { textResult, formatContentLines } from "./content.ts";

const schema = Type.Object({
	query: Type.String({
		description:
			"Overpass QL query including [out:json] prefix, e.g. '[out:json][timeout:25];node[amenity=pub](52.5,13.3,52.6,13.4);out center;'",
	}),
});

export const queryOsmModule = defineTool<
	{ kind: "query_osm"; entries: OverpassResultEntry[] },
	{ overpass: OverpassClient },
	typeof schema,
	ToolProgress | QueryOsmToolDetails | { busy: true } | undefined
>({
	name: "query_osm",
	label: "Query OSM",
	description:
		"Run an Overpass QL query against OpenStreetMap data. Use for finding features by tag, area, or geometry. Always include '[out:json]' prefix and a timeout. Use 'out center;' for ways/relations to get center coordinates.",
	parameters: schema,
	detailsSchema: QueryOsmToolDetailsSchema,
	parse: parseSchema(QueryOsmToolDetailsSchema, (d) => ({ kind: "query_osm", entries: d.data })),
	execute: async ({ overpass }, _toolCallId, params, signal, onUpdate) => {
		if (signal?.aborted) throw new ToolAbortedError({ message: "Operation aborted" });
		const result = await Result.gen(async function* () {
			const response = yield* Result.await(
				overpass.query(params.query, signal, {
					onProgress: (progress) => onUpdate?.({ content: [], details: progress }),
				}),
			);
			const elements = response.elements ?? [];
			if (elements.length === 0) {
				return Result.ok({
					...textResult("No results."),
					details: { data: [] },
				});
			}
			const data = elements.map(overpassElementToData);
			const text = formatContentLines(
				elements,
				formatElement,
				(rest) =>
					`…and ${rest} more results. All results are shown on the map. Refine the query to narrow down.`,
			);
			return Result.ok({
				...textResult(text),
				details: { data },
			});
		});
		if (Result.isOk(result)) return result.value;
		// OSM-busy is converted into a normal (non-error) result so the model
		// does not retry; every other error re-throws so the agent marks the
		// tool call `isError: true` exactly as before (issue #109).
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
});
