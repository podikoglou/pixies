import { Type } from "typebox";
import type { Static } from "typebox";

export const GeocodeResultEntrySchema = Type.Object({
	placeId: Type.Number(),
	lat: Type.Number(),
	lon: Type.Number(),
	name: Type.String(),
	displayName: Type.Optional(Type.String()),
	class: Type.Optional(Type.String()),
	type: Type.Optional(Type.String()),
	osmType: Type.Optional(
		Type.Union([Type.Literal("node"), Type.Literal("way"), Type.Literal("relation")]),
	),
	osmId: Type.Optional(Type.Number()),
});
export type GeocodeResultEntry = Static<typeof GeocodeResultEntrySchema>;

export const OverpassResultEntrySchema = Type.Object({
	type: Type.Union([Type.Literal("node"), Type.Literal("way"), Type.Literal("relation")]),
	id: Type.Number(),
	lat: Type.Optional(Type.Number()),
	lon: Type.Optional(Type.Number()),
	name: Type.Optional(Type.String()),
	tags: Type.Optional(Type.Record(Type.String(), Type.String())),
	geometryPoints: Type.Optional(Type.Number()),
});
export type OverpassResultEntry = Static<typeof OverpassResultEntrySchema>;

export const GeocodeToolDetailsSchema = Type.Object({
	top: Type.Optional(Type.String()),
	data: Type.Array(GeocodeResultEntrySchema),
});
export type GeocodeToolDetails = Static<typeof GeocodeToolDetailsSchema>;

export const ReverseGeocodeToolDetailsSchema = Type.Object({
	name: Type.Optional(Type.String()),
	data: GeocodeResultEntrySchema,
});
export type ReverseGeocodeToolDetails = Static<typeof ReverseGeocodeToolDetailsSchema>;

export const QueryOsmToolDetailsSchema = Type.Object({
	count: Type.Number(),
	data: Type.Array(OverpassResultEntrySchema),
});
export type QueryOsmToolDetails = Static<typeof QueryOsmToolDetailsSchema>;

export const DisplayMapDataSchema = Type.Object({
	markers: Type.Array(
		Type.Object({
			lat: Type.Number(),
			lon: Type.Number(),
			label: Type.Optional(Type.String()),
		}),
	),
	queryRef: Type.Optional(Type.String()),
	elementIds: Type.Optional(Type.Array(Type.String())),
	bounds: Type.Optional(
		Type.Object({
			minlat: Type.Number(),
			minlon: Type.Number(),
			maxlat: Type.Number(),
			maxlon: Type.Number(),
		}),
	),
});
export type DisplayMapData = Static<typeof DisplayMapDataSchema>;

export const DisplayMapToolDetailsSchema = Type.Object({
	data: DisplayMapDataSchema,
});
export type DisplayMapToolDetails = Static<typeof DisplayMapToolDetailsSchema>;
