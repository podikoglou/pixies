import { createContext, useContext, type ReactNode } from "react";
import { useMapSearch } from "@/hooks/use-map-search";

type MapContextValue = ReturnType<typeof useMapSearch>;

const MapContext = createContext<MapContextValue | null>(null);

/**
 * Wraps the application tree with the map-centric state machine, exposing
 * {@link useMapSearch} via context so any descendant can read state or dispatch
 * actions without prop drilling.
 */
export function MapProvider({ children }: { children: ReactNode }) {
	const map = useMapSearch();
	return <MapContext.Provider value={map}>{children}</MapContext.Provider>;
}

/** Read the map-centric state and actions. Throws if used outside a MapProvider. */
export function useMapContext(): MapContextValue {
	const ctx = useContext(MapContext);
	if (!ctx) throw new Error("useMapContext must be used within a MapProvider");
	return ctx;
}
