import { Result, matchErrorPartial } from "better-result";
import { Type } from "typebox";
import type { OverpassClient, OverpassElement } from "../clients/overpass.ts";
import { formatElement, getElementCoords } from "../clients/overpass.ts";
import { ToolAbortedError } from "../errors.ts";
import { OSM_SERVER_BUSY_MESSAGE } from "./busy-message.ts";
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
		// tool call `isError: true` exactly as before.
		return matchErrorPartial(
			result.error,
			{
				OverpassBusy: () => ({
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

/**
 * Structured, lossless representation of an Overpass element for UI consumers.
 * Content-side counterpart to {@link formatElement}. `name` is hoisted to a
 * top-level field (mirroring {@link formatElement}) and excluded from `tags`
 * so each piece of information appears once in the rendered tree.
 */
function overpassElementToData(el: OverpassElement): OverpassResultEntry {
	const coord = getElementCoords(el);
	const otherTags = el.tags
		? Object.fromEntries(Object.entries(el.tags).filter(([k]) => k !== "name"))
		: undefined;
	return {
		type: el.type,
		id: el.id,
		...(coord ? { lat: coord.lat, lon: coord.lon } : {}),
		...(el.tags?.name ? { name: el.tags.name } : {}),
		...(otherTags && Object.keys(otherTags).length > 0 ? { tags: otherTags } : {}),
		...(el.geometry && el.geometry.length > 0 ? { geometryPoints: el.geometry.length } : {}),
	};
}
