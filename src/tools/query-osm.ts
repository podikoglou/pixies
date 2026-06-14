import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { formatElement } from "../osm/format.ts";
import { overpass } from "../osm/overpass.ts";

const schema = Type.Object({
	query: Type.String({
		description:
			"Overpass QL query including [out:json] prefix, e.g. '[out:json][timeout:25];node[amenity=pub](52.5,13.3,52.6,13.4);out center;'",
	}),
});

export interface QueryOsmToolDetails {
	count: number;
}

export const queryOsmTool: AgentTool<typeof schema, QueryOsmToolDetails | undefined> = {
	name: "query_osm",
	label: "Query OSM",
	description:
		"Run an Overpass QL query against OpenStreetMap data. Use for finding features by tag, area, or geometry. Always include '[out:json]' prefix and a timeout. Use 'out center;' for ways/relations to get center coordinates.",
	parameters: schema,
	async execute(_toolCallId, params, signal) {
		if (signal?.aborted) throw new Error("Operation aborted");
		const response = await overpass.query(params.query, signal);
		const elements = response.elements ?? [];
		if (elements.length === 0) {
			return {
				content: [{ type: "text", text: "No results." }],
				details: { count: 0 },
			};
		}
		const lines = elements.map(formatElement);
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { count: elements.length },
		};
	},
};
