import { parseToolResult } from "@pixies/core";
import {
	displaysToMarkers,
	displaysToPolylines,
	displaysToBounds,
	type MapMarker,
	type MapPolyline,
} from "../lib/resolve-map-markers.ts";

/**
 * One search result rendered as a toggleable layer on the persistent map.
 *
 * A layer is created from a single {@link execute_code} tool result that carries
 * at least one marker or polyline. Layers are ordered by creation time; only the
 * active (most recent) layer is visible, but all are retained in state for
 * future toggling.
 */
export interface Layer {
	query: string;
	markers: MapMarker[];
	polylines: MapPolyline[];
	bounds: { minlat: number; minlon: number; maxlat: number; maxlon: number } | null;
}

/**
 * Map-centric state — replaces the chat {@link TimelineItem[]} model with a
 * layer stack. The active layer is always the most-recently-added one; previous
 * layers are hidden but retained.
 */
export interface MapState {
	conversationId: string | null;
	layers: Layer[];
	/** Index into `layers`, or -1 when no layers exist. */
	activeLayerIndex: number;
	/** The user's query text for the current stream — used as the layer's label. */
	lastQuery: string | null;
	isStreaming: boolean;
	error: string | null;
}

export const initialMapState: MapState = {
	conversationId: null,
	layers: [],
	activeLayerIndex: -1,
	lastQuery: null,
	isStreaming: false,
	error: null,
};

export type MapAction =
	| { type: "SEND_MESSAGE"; text: string }
	| { type: "CONVERSATION_CREATED"; id: string }
	| { type: "TOOL_END"; toolName: string; isError: boolean; details: unknown }
	| { type: "STREAM_DONE" }
	| { type: "SET_ERROR"; message: string }
	| { type: "LOAD_TRANSCRIPT"; conversationId: string; layers: Layer[] }
	| { type: "RESET" };

export function mapReducer(state: MapState, action: MapAction): MapState {
	switch (action.type) {
		case "SEND_MESSAGE":
			return {
				...state,
				lastQuery: action.text,
				isStreaming: true,
				error: null,
			};

		case "CONVERSATION_CREATED":
			return { ...state, conversationId: action.id };

		case "TOOL_END": {
			if (action.isError) return state;
			if (action.toolName !== "execute_code") return state;

			const parsed = parseToolResult(action.toolName, action.details);
			if (parsed.kind !== "execute_code") return state;

			const markers = displaysToMarkers(parsed.displays);
			const polylines = displaysToPolylines(parsed.displays);
			if (markers.length === 0 && polylines.length === 0) return state;

			const layer: Layer = {
				query: state.lastQuery ?? "",
				markers,
				polylines,
				bounds: displaysToBounds(parsed.displays),
			};

			return {
				...state,
				layers: [...state.layers, layer],
				activeLayerIndex: state.layers.length,
			};
		}

		case "STREAM_DONE":
			return { ...state, isStreaming: false };

		case "SET_ERROR":
			return { ...state, isStreaming: false, error: action.message };

		case "LOAD_TRANSCRIPT":
			return {
				...state,
				conversationId: action.conversationId,
				layers: action.layers,
				activeLayerIndex: action.layers.length > 0 ? action.layers.length - 1 : -1,
				isStreaming: false,
				error: null,
			};

		case "RESET":
			return initialMapState;
	}
}
