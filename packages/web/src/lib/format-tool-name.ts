const TOOL_LABELS: Record<string, string> = {
	geocode: "Geocode",
	reverse_geocode: "Reverse geocode",
	query_osm: "Query OSM",
	display_map: "Display Map",
};

export function formatToolName(name: string): string {
	const label = TOOL_LABELS[name];
	if (label) return label;
	return name
		.split("_")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}
