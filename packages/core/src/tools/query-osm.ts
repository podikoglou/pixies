import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { OverpassClient } from "../osm/overpass.ts";
import { OsmServerBusyError, OSM_SERVER_BUSY_MESSAGE } from "../osm/http.ts";
import { formatElement, overpassElementToData } from "../osm/format.ts";
import type { QueryOsmToolDetails } from "./index.ts";

const schema = Type.Object({
	query: Type.String({
		description:
			"Overpass QL query including [out:json] prefix, e.g. '[out:json][timeout:25];node[amenity=pub](52.5,13.3,52.6,13.4);out center;'",
	}),
});

export function createQueryOsmTool(
	overpass: OverpassClient,
): AgentTool<typeof schema, QueryOsmToolDetails | undefined> {
	return {
		name: "query_osm",
		label: "Query OSM",
		description:
			"Run an Overpass QL query against OpenStreetMap data. Use for finding features by tag, area, or geometry. Always include '[out:json]' prefix and a timeout. Use 'out center;' for ways/relations to get center coordinates.",
		parameters: schema,
		async execute(_toolCallId, params, signal) {
			if (signal?.aborted) throw new Error("Operation aborted");
			try {
				const response = await overpass.query(params.query, signal);
				const elements = response.elements ?? [];
				if (elements.length === 0) {
					return {
						content: [{ type: "text", text: "No results." }],
						details: { count: 0, data: [] },
					};
				}
				const lines = elements.map(formatElement);
				const data = elements.map(overpassElementToData);
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { count: elements.length, data },
				};
			} catch (err) {
				if (err instanceof OsmServerBusyError) {
					return { content: [{ type: "text", text: OSM_SERVER_BUSY_MESSAGE }], details: undefined };
				}
				throw err;
			}
		},
	};
}
