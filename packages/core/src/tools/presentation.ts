import type { ToolName } from "./index.ts";

export const TOOL_LABELS: Record<ToolName, string> = {
	geocode: "Geocode",
	reverse_geocode: "Reverse geocode",
	query_osm: "Query OSM",
};

export function toolLabel(name: string): string {
	if (name in TOOL_LABELS) return TOOL_LABELS[name as ToolName];
	return name
		.split("_")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

export function summarizeToolDetails(name: string, details: unknown): string | undefined {
	if (!details || typeof details !== "object") return undefined;
	const d = details as Record<string, unknown>;
	if (name === "geocode" && typeof d.top === "string") return d.top;
	if (name === "reverse_geocode" && typeof d.name === "string") return d.name;
	if (name === "query_osm" && typeof d.count === "number") return `${d.count} elements`;
	return undefined;
}
