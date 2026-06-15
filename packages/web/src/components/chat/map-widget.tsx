import { useEffect, useRef } from "react";
import L from "leaflet";
import { cn } from "@/lib/utils";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";

export interface MapWidgetProps {
	markers?: Array<{ lat: number; lon: number; label?: string }>;
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

export function MapWidget({ markers, bounds, className }: MapWidgetProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const mapRef = useRef<L.Map | null>(null);
	const markersLayerRef = useRef<L.LayerGroup | null>(null);

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

		markersLayerRef.current = L.layerGroup().addTo(map);

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
		const layer = markersLayerRef.current;
		if (!layer || !map) return;

		layer.clearLayers();

		if (!markers) return;

		for (const { lat, lon, label } of markers) {
			const marker = L.marker([lat, lon]);
			if (label) {
				marker.bindPopup(label);
			}
			marker.addTo(layer);
		}

		if (bounds === undefined && markers.length > 0) {
			if (markers.length === 1) {
				const m = markers[0]!;
				map.setView([m.lat, m.lon], 13);
			} else {
				const latLngs = markers.map((m) => L.latLng(m.lat, m.lon));
				map.fitBounds(L.latLngBounds(latLngs), { padding: [30, 30] });
			}
		}
	}, [markers]);

	return <div ref={containerRef} className={cn("h-[400px] w-full rounded-md border", className)} />;
}
