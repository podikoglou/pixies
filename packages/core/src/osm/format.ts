import type { NominatimResult } from "./nominatim.ts";
import type { OverpassElement } from "./overpass.ts";
import type { GeocodeResultEntry, OverpassResultEntry } from "../tools/index.ts";

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

	const otherTags = el.tags ? Object.entries(el.tags).filter(([k]) => k !== "name") : [];
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

	const category = r.class && r.type ? `${r.class}/${r.type}` : (r.class ?? r.type);
	if (category) segments.push(category);

	return segments.join(" | ");
}

/**
 * Structured, lossless representation of a Nominatim result for UI consumers.
 * This is the content-side counterpart to {@link formatNominatimResult}: the
 * pipe string stays as the model-facing serialization, this object is the
 * wire contract for structured rendering (issue #15).
 */
export function nominatimResultToData(r: NominatimResult): GeocodeResultEntry {
	return {
		placeId: r.place_id,
		lat: Number(r.lat),
		lon: Number(r.lon),
		name: r.name || r.display_name?.split(",")[0] || "unknown",
		...(r.display_name ? { displayName: r.display_name } : {}),
		...(r.class ? { class: r.class } : {}),
		...(r.type ? { type: r.type } : {}),
		...(r.osm_type ? { osmType: r.osm_type } : {}),
		...(r.osm_id !== undefined ? { osmId: r.osm_id } : {}),
	};
}

/**
 * Structured, lossless representation of an Overpass element for UI consumers.
 * Content-side counterpart to {@link formatElement}. `name` is hoisted to a
 * top-level field (mirroring {@link formatElement}) and excluded from `tags`
 * so each piece of information appears once in the rendered tree.
 */
export function overpassElementToData(el: OverpassElement): OverpassResultEntry {
	const coord = getElementCoords(el);
	const otherTags = el.tags
		? Object.fromEntries(Object.entries(el.tags).filter(([k]) => k !== "name"))
		: undefined;
	const data: OverpassResultEntry = {
		type: el.type,
		id: el.id,
		...(coord ? { lat: coord.lat, lon: coord.lon } : {}),
		...(el.tags?.name ? { name: el.tags.name } : {}),
		...(otherTags && Object.keys(otherTags).length > 0 ? { tags: otherTags } : {}),
		...(el.geometry && el.geometry.length > 0 ? { geometryPoints: el.geometry.length } : {}),
	};
	return data;
}
