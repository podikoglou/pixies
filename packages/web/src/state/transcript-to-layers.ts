import type { ConversationTranscript } from "../api/conversations.ts";
import { parseToolResult, isBusyResult } from "@pixies/core";
import {
	displaysToMarkers,
	displaysToPolylines,
	displaysToBounds,
} from "../lib/resolve-map-markers.ts";
import { joinContentText } from "./chat-reducer.ts";
import type { Layer } from "./map-reducer.ts";

/**
 * Walk a conversation transcript and reconstruct a {@link Layer} for every
 * {@link execute_code} tool result that carries renderable data (markers or
 * polylines). Layers are ordered by their appearance in the transcript.
 *
 * Errors, busy results, and results with no map data are skipped. The user
 * message immediately preceding each tool result provides the query label.
 */
export function transcriptToLayers(transcript: ConversationTranscript): Layer[] {
	const layers: Layer[] = [];
	let lastQuery: string | null = null;

	for (const msg of transcript.messages) {
		switch (msg.role) {
			case "user":
				lastQuery = joinContentText(msg.content, "");
				break;

			case "toolResult": {
				if (msg.isError) continue;
				if (msg.toolName !== "execute_code") continue;
				if (isBusyResult(msg.details)) continue;

				const parsed = parseToolResult(msg.toolName, msg.details);
				if (parsed.kind !== "execute_code") continue;

				const markers = displaysToMarkers(parsed.displays);
				const polylines = displaysToPolylines(parsed.displays);
				if (markers.length === 0 && polylines.length === 0) continue;

				layers.push({
					query: lastQuery ?? "",
					markers,
					polylines,
					bounds: displaysToBounds(parsed.displays),
				});
				break;
			}
		}
	}

	return layers;
}
