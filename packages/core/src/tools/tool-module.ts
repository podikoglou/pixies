import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import type { NominatimClient } from "../osm/nominatim.ts";
import type { OverpassClient } from "../osm/overpass.ts";

export interface OsmClients {
	nominatim: NominatimClient;
	overpass: OverpassClient;
}

export interface ToolModule<TResult extends { kind: string }> {
	factory: (clients: OsmClients) => AgentTool;
	detailsSchema: TSchema;
	parse: (details: unknown) => TResult | null;
	summarize: (result: TResult) => string | null;
}
