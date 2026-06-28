import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet.markercluster";
import "leaflet.markercluster/dist/MarkerCluster.css";
import "leaflet.markercluster/dist/MarkerCluster.Default.css";
import { useAnalytics } from "@/hooks/use-analytics";
import { cn } from "@/lib/utils";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";

export interface MapPolyline {
	from: { lat: number; lon: number };
	to: { lat: number; lon: number };
}

export interface MapWidgetProps {
	markers?: Array<{ lat: number; lon: number; label?: string }>;
	polylines?: MapPolyline[];
	bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number };
	className?: string;
}

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

export function MapWidget({ markers, polylines, bounds, className }: MapWidgetProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const mapRef = useRef<L.Map | null>(null);
	const markersLayerRef = useRef<L.MarkerClusterGroup | null>(null);
	const polylinesLayerRef = useRef<L.LayerGroup | null>(null);
	const analytics = useAnalytics();
	const openedCapturedRef = useRef(false);

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

		// Polylines live in their own layer group (no clustering — the lines
		// connect already-placed markers and shouldn't be hidden by clustering).
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

	useEffect(() => {
		const map = mapRef.current;
		if (!map) return;

		if (bounds) {
			const { minlat, minlon, maxlat, maxlon } = bounds;
			map.fitBounds([
				[minlat, minlon],
				[maxlat, maxlon],
			]);
		}
	}, [bounds]);

	useEffect(() => {
		const map = mapRef.current;
		const cluster = markersLayerRef.current;
		const polylineLayer = polylinesLayerRef.current;
		if (!cluster || !map) return;

		cluster.clearLayers();
		polylineLayer?.clearLayers();

		// Polylines render first so markers sit on top of the connectors.
		if (polylines && polylineLayer) {
			for (const { from, to } of polylines) {
				L.polyline(
					[
						[from.lat, from.lon],
						[to.lat, to.lon],
					],
					{ color: "#3b82f6", weight: 2, opacity: 0.6 },
				).addTo(polylineLayer);
			}
		}

		if (!markers) return;

		const leafletMarkers = markers.map(({ lat, lon, label }) => {
			const marker = L.marker([lat, lon]);
			if (label) {
				marker.bindPopup(label);
			}
			return marker;
		});
		cluster.addLayers(leafletMarkers);

		if (bounds === undefined && markers.length > 0 && (!polylines || polylines.length === 0)) {
			if (markers.length === 1) {
				const m = markers[0]!;
				map.setView([m.lat, m.lon], 13);
			} else {
				const latLngs = markers.map((m) => L.latLng(m.lat, m.lon));
				map.fitBounds(L.latLngBounds(latLngs), { padding: [30, 30] });
			}
		} else if (bounds === undefined && polylines && polylines.length > 0) {
			// Fit to the union of polyline endpoints so the relationship is visible.
			const latLngs = polylines.flatMap((p) => [
				L.latLng(p.from.lat, p.from.lon),
				L.latLng(p.to.lat, p.to.lon),
			]);
			map.fitBounds(L.latLngBounds(latLngs), { padding: [30, 30] });
		}
	}, [markers, polylines, bounds]);

	// A map "opens" for the user once it actually shows results; capture that
	// once per widget instance — each tool result mounts its own MapWidget, and
	// the count reveals result richness, never the query itself.
	useEffect(() => {
		if (openedCapturedRef.current) return;
		if (!markers || markers.length === 0) return;
		analytics.capture("map_opened", { marker_count: markers.length });
		openedCapturedRef.current = true;
	}, [markers, analytics]);

	return <div ref={containerRef} className={cn("h-[400px] w-full rounded-md border", className)} />;
}
