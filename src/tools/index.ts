import type { AgentTool } from "@earendil-works/pi-agent-core";
import { geocodeTool } from "./geocode.ts";
import { queryOsmTool } from "./query-osm.ts";
import { reverseGeocodeTool } from "./reverse-geocode.ts";

export const tools: AgentTool[] = [geocodeTool, reverseGeocodeTool, queryOsmTool];

export { geocodeTool, queryOsmTool, reverseGeocodeTool };
