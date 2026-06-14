import type { NominatimResult } from "./nominatim.ts";
import type { OverpassElement } from "./overpass.ts";

function formatCoord(lat: number, lon: number): string {
	return `${lat},${lon}`;
}

function getElementCoords(el: OverpassElement): { lat: number; lon: number } | null {
	if (el.lat !== undefined && el.lon !== undefined) return { lat: el.lat, lon: el.lon };
	if (el.center) return el.center;
	return null;
}

export function formatElement(el: OverpassElement): string {
	const segments: string[] = [`${el.type}/${el.id}`];

	const coord = getElementCoords(el);
	if (coord) {
		segments.push(formatCoord(coord.lat, coord.lon));
	} else if (el.type !== "node") {
		segments.push("(no center)");
	}

	const name = el.tags?.name;
	if (name) segments.push(name);

	const otherTags = el.tags
		? Object.entries(el.tags).filter(([k]) => k !== "name")
		: [];
	const tail: string[] = [];
	if (otherTags.length > 0) {
		tail.push(otherTags.map(([k, v]) => `${k}=${v}`).join(", "));
	}
	if (el.geometry && el.geometry.length > 0) {
		tail.push(`geom=${el.geometry.length}pts`);
	}
	if (tail.length > 0) segments.push(tail.join(", "));

	return segments.join(" | ");
}

export function formatNominatimResult(r: NominatimResult): string {
	const segments: string[] = [];

	if (r.osm_type && r.osm_id !== undefined) {
		segments.push(`${r.osm_type}/${r.osm_id}`);
	} else {
		segments.push(`place/${r.place_id}`);
	}

	segments.push(`${r.lat},${r.lon}`);

	if (r.display_name) segments.push(r.display_name);

	const category = r.class && r.type ? `${r.class}/${r.type}` : r.class ?? r.type;
	if (category) segments.push(category);

	return segments.join(" | ");
}
