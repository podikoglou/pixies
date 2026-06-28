import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import L from "leaflet";
import "leaflet.markercluster";
import "leaflet.markercluster/dist/MarkerCluster.css";
import "leaflet.markercluster/dist/MarkerCluster.Default.css";
import { useMapContext } from "@/contexts/map-context";
import { useAnalytics } from "@/hooks/use-analytics";
import { OsmDisclaimer } from "@/components/chat/osm-disclaimer";
import { SearchBar } from "./search-bar";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";
import type { MapPolyline as PolylineType } from "@/lib/resolve-map-markers";

// @ts-expect-error _getIconUrl is private in Leaflet types
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
	iconRetinaUrl: markerIcon2x,
	iconUrl: markerIcon,
	shadowUrl: markerShadow,
});

const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const ATTRIBUTION =
	'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const DEFAULT_CENTER: L.LatLngExpression = [20, 0];
const DEFAULT_ZOOM = 2;

interface MapViewProps {
	onConversationCreated?: (id: string) => void;
}

/**
 * Full-viewport persistent map — replaces the chat timeline. The map instance
 * lives for the lifetime of the component; each new search query adds a layer
 * that replaces the active view.
 *
 * Layout: header → map (flex-1, min-h-0) → disclaimer → search bar.
 */
export function MapView({ onConversationCreated }: MapViewProps = {}) {
	const { state, sendMessage, abort, reset, hadOutputRef } = useMapContext();
	const navigate = useNavigate();
	const analytics = useAnalytics();
	const [text, setText] = useState("");

	const handleSubmit = () => {
		const trimmed = text.trim();
		if (!trimmed || state.isStreaming) return;
		analytics.capture("message_sent", { is_new_conversation: state.conversationId === null });
		sendMessage(trimmed, {
			onConversationCreated,
			onToolError: (toolName) => analytics.capture("tool_error", { tool_name: toolName }),
			onToolEmpty: (props) => analytics.capture("tool_empty", props),
		});
		setText("");
	};

	// Error toasts — match the chat-view pattern exactly.
	useEffect(() => {
		if (state.error) toast.error(state.error);
	}, [state.error]);

	return (
		<div className="flex h-dvh flex-col">
			<header className="border-border border-b">
				<div className="mx-auto px-4 py-2.5">
					<button
						type="button"
						onClick={() => {
							reset();
							navigate({ to: "/" });
						}}
						className="text-muted-foreground text-sm font-medium tracking-tight"
					>
						pixies
					</button>
				</div>
			</header>

			<PersistentMap
				layers={state.layers}
				activeLayerIndex={state.activeLayerIndex}
				analytics={analytics}
			/>

			<OsmDisclaimer />

			<SearchBar
				value={text}
				onChange={setText}
				onSubmit={handleSubmit}
				isStreaming={state.isStreaming}
				onAbort={() => {
					analytics.capture("user_stop", {
						had_output: hadOutputRef.current,
					});
					abort();
				}}
			/>
		</div>
	);
}

// ─── Internal map component ───────────────────────────────────────────────

interface PersistentMapProps {
	layers: {
		markers: { lat: number; lon: number; label?: string }[];
		polylines: PolylineType[];
		bounds: { minlat: number; minlon: number; maxlat: number; maxlon: number } | null;
	}[];
	activeLayerIndex: number;
	analytics: ReturnType<typeof useAnalytics>;
}

function PersistentMap({ layers, activeLayerIndex, analytics }: PersistentMapProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const mapRef = useRef<L.Map | null>(null);
	const markersLayerRef = useRef<L.MarkerClusterGroup | null>(null);
	const polylinesLayerRef = useRef<L.LayerGroup | null>(null);
	const openedLayersRef = useRef(new Set<number>());

	const activeLayer = layers[activeLayerIndex] ?? null;

	// Initialize the map once — it survives across queries.
	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		const map = L.map(container, {
			center: DEFAULT_CENTER,
			zoom: DEFAULT_ZOOM,
		});

		L.tileLayer(TILE_URL, {
			attribution: ATTRIBUTION,
			maxZoom: 19,
		}).addTo(map);

		const cluster = L.markerClusterGroup({ chunkedLoading: true });
		cluster.addTo(map);
		markersLayerRef.current = cluster;

		const polylineLayer = L.layerGroup().addTo(map);
		polylinesLayerRef.current = polylineLayer;

		const observer = new ResizeObserver(() => {
			map.invalidateSize();
		});
		observer.observe(container);

		mapRef.current = map;

		return () => {
			observer.disconnect();
			map.remove();
			mapRef.current = null;
			markersLayerRef.current = null;
			polylinesLayerRef.current = null;
		};
	}, []);

	// Update markers and polylines when the active layer changes.
	useEffect(() => {
		const map = mapRef.current;
		const cluster = markersLayerRef.current;
		const polylineLayer = polylinesLayerRef.current;
		if (!map || !cluster) return;

		cluster.clearLayers();
		polylineLayer?.clearLayers();

		if (!activeLayer) return;

		// Polylines render first so markers sit on top of the connectors.
		if (activeLayer.polylines.length > 0 && polylineLayer) {
			for (const { from, to } of activeLayer.polylines) {
				L.polyline(
					[
						[from.lat, from.lon],
						[to.lat, to.lon],
					],
					{ color: "#3b82f6", weight: 2, opacity: 0.6 },
				).addTo(polylineLayer);
			}
		}

		if (activeLayer.markers.length > 0) {
			const leafletMarkers = activeLayer.markers.map(({ lat, lon, label }) => {
				const marker = L.marker([lat, lon]);
				if (label) marker.bindPopup(label);
				return marker;
			});
			cluster.addLayers(leafletMarkers);
		}
	}, [activeLayer]);

	// Fire map_opened once per layer that carries markers.
	useEffect(() => {
		if (activeLayerIndex < 0) return;
		if (openedLayersRef.current.has(activeLayerIndex)) return;
		const layer = layers[activeLayerIndex];
		if (!layer || layer.markers.length === 0) return;
		analytics.capture("map_opened", { marker_count: layer.markers.length });
		openedLayersRef.current.add(activeLayerIndex);
	}, [activeLayerIndex, layers, analytics]);

	// Fly to active layer bounds when the layer or its bounds change.
	const flyToLayer = useCallback(() => {
		const map = mapRef.current;
		if (!map) return;

		if (!activeLayer) {
			map.setView(DEFAULT_CENTER, DEFAULT_ZOOM);
			return;
		}

		if (activeLayer.bounds) {
			const { minlat, minlon, maxlat, maxlon } = activeLayer.bounds;
			map.fitBounds([
				[minlat, minlon],
				[maxlat, maxlon],
			]);
		} else if (activeLayer.markers.length > 0) {
			if (activeLayer.markers.length === 1) {
				const m = activeLayer.markers[0]!;
				map.setView([m.lat, m.lon], 13);
			} else {
				const latLngs = activeLayer.markers.map((m) => L.latLng(m.lat, m.lon));
				map.fitBounds(L.latLngBounds(latLngs), { padding: [30, 30] });
			}
		} else if (activeLayer.polylines.length > 0) {
			const latLngs = activeLayer.polylines.flatMap((p) => [
				L.latLng(p.from.lat, p.from.lon),
				L.latLng(p.to.lat, p.to.lon),
			]);
			map.fitBounds(L.latLngBounds(latLngs), { padding: [30, 30] });
		}
	}, [activeLayer]);

	useEffect(() => {
		flyToLayer();
	}, [flyToLayer]);

	return <div ref={containerRef} className="min-h-0 flex-1" />;
}
