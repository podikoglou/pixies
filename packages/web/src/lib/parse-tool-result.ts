interface ParsedOsmElement {
	id: string;
	lat?: number;
	lon?: number;
	name?: string;
	tags?: Record<string, string>;
}

interface ParsedGeocodeResult {
	id: string;
	lat: number;
	lon: number;
	name: string;
	category?: string;
}

const TAG_KEY_RE = /^[a-zA-Z0-9_:]+=/;

function parseTags(text: string): Record<string, string> {
	const tags: Record<string, string> = {};
	const chunks = text.split(", ");
	let currentKey = "";
	for (const chunk of chunks) {
		if (TAG_KEY_RE.test(chunk)) {
			const eqIdx = chunk.indexOf("=");
			currentKey = chunk.slice(0, eqIdx);
			tags[currentKey] = chunk.slice(eqIdx + 1);
		} else if (currentKey) {
			tags[currentKey] += `, ${chunk}`;
		}
	}
	return tags;
}

function parseOsmElementLine(line: string): ParsedOsmElement {
	const parts = line.split(" | ");
	const result: ParsedOsmElement = { id: parts[0] ?? line };

	if (parts[1]) {
		const coords = parts[1].split(",");
		if (coords.length === 2 && coords[0] && coords[1]) {
			result.lat = Number(coords[0]);
			result.lon = Number(coords[1]);
		}
	}

	for (let i = 2; i < parts.length; i++) {
		const seg = parts[i];
		if (!seg) continue;
		if (TAG_KEY_RE.test(seg) || seg.startsWith("geom=")) {
			const parsed = parseTags(seg);
			if (result.tags) {
				Object.assign(result.tags, parsed);
			} else {
				result.tags = parsed;
			}
		} else if (!result.name) {
			result.name = seg;
		}
	}

	return result;
}

function parseGeocodeLine(line: string): ParsedGeocodeResult {
	const parts = line.split(" | ");
	const id = parts[0] ?? line;
	const coords = (parts[1] ?? "").split(",");
	const lat = coords[0] ? Number(coords[0]) : 0;
	const lon = coords[1] ? Number(coords[1]) : 0;
	const name = parts[2] ?? "";
	const category = parts[3];

	return category ? { id, lat, lon, name, category } : { id, lat, lon, name };
}

export function parseToolResult(toolName: string, resultText: string): unknown {
	const trimmed = resultText.trim();
	if (!trimmed || trimmed === "No results.") return null;

	const lines = trimmed.split("\n").filter((l) => l.trim().length > 0);

	if (toolName === "geocode" || toolName === "reverse_geocode") {
		return lines.map(parseGeocodeLine);
	}

	if (toolName === "query_osm") {
		return lines.map(parseOsmElementLine);
	}

	return resultText;
}
