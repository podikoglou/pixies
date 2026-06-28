import { createContext, useContext, type ReactNode } from "react";
import { useMapSearch } from "@/hooks/use-map-search";

type MapContextValue = ReturnType<typeof useMapSearch>;

const MapContext = createContext<MapContextValue | null>(null);

export function MapProvider({ children }: { children: ReactNode }) {
	const map = useMapSearch();
	return <MapContext.Provider value={map}>{children}</MapContext.Provider>;
}

export function useMapContext(): MapContextValue {
	const ctx = useContext(MapContext);
	if (!ctx) throw new Error("useMapContext must be used within a MapProvider");
	return ctx;
}
