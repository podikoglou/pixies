import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import { cn } from "@/lib/utils";

export interface MapWidgetProps {
	markers?: Array<{ lat: number; lon: number; label?: string }>;
	bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number };
	className?: string;
}

delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
	iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
	iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
	shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
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
	const [mounted, setMounted] = useState(false);

	useEffect(() => {
		setMounted(true);
	}, []);

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
		const layer = markersLayerRef.current;
		if (!layer) return;

		layer.clearLayers();

		if (!markers) return;

		for (const { lat, lon, label } of markers) {
			const marker = L.marker([lat, lon]);
			if (label) {
				marker.bindPopup(label);
			}
			marker.addTo(layer);
		}
	}, [markers]);

	if (!mounted) return null;

	return <div ref={containerRef} className={cn("h-[400px] w-full rounded-md border", className)} />;
}
