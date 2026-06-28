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
	data: Type.Array(GeocodeResultEntrySchema),
	busy: Type.Optional(Type.Literal(true)),
});
export type GeocodeToolDetails = Static<typeof GeocodeToolDetailsSchema>;

export const ReverseGeocodeToolDetailsSchema = Type.Object({
	data: GeocodeResultEntrySchema,
	busy: Type.Optional(Type.Literal(true)),
});
export type ReverseGeocodeToolDetails = Static<typeof ReverseGeocodeToolDetailsSchema>;

export const QueryOsmToolDetailsSchema = Type.Object({
	data: Type.Array(OverpassResultEntrySchema),
	busy: Type.Optional(Type.Literal(true)),
});
export type QueryOsmToolDetails = Static<typeof QueryOsmToolDetailsSchema>;

/**
 * Minimal element shape the dependency-layer tools (find_features, filter,
 * spatial_join) exchange and store. A common subset of {@link OverpassResultEntry}
 * and {@link GeocodeResultEntry}: identity + coordinates + optional name/tags.
 * `additionalProperties: false` keeps the wire shape tight; the model-facing
 * `tags` map is the same one filter's where-clause predicates against.
 */
export const StoredElementSchema = Type.Object(
	{
		id: Type.String({
			description: "Stable element identity: '<type>/<id>' or 'place/<placeId>'.",
		}),
		type: Type.Optional(
			Type.Union([Type.Literal("node"), Type.Literal("way"), Type.Literal("relation")]),
		),
		lat: Type.Optional(Type.Number()),
		lon: Type.Optional(Type.Number()),
		name: Type.Optional(Type.String()),
		tags: Type.Optional(Type.Record(Type.String(), Type.String())),
	},
	{ additionalProperties: false },
);
/** Wire shape of a stored element. Structurally identical to the runtime `StoredElement` in stored-element.ts. */
export type StoredElement = Static<typeof StoredElementSchema>;

export const DisplayMapDataSchema = Type.Object({
	markers: Type.Array(
		Type.Object({
			lat: Type.Number(),
			lon: Type.Number(),
			label: Type.Optional(Type.String()),
		}),
	),
	queryRef: Type.Optional(Type.String()),
	/** Element-bearing result reference (find_features / filter / geocode). */
	elementsRef: Type.Optional(Type.String()),
	/** spatial_join result reference; client draws polylines between matched pairs. */
	pairsRef: Type.Optional(Type.String()),
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

/** Shared bbox shape used by find_features / filter / spatial_join details. */
const BoundsSchema = Type.Object({
	minlat: Type.Number(),
	minlon: Type.Number(),
	maxlat: Type.Number(),
	maxlon: Type.Number(),
});

export const FindFeaturesToolDetailsSchema = Type.Object({
	data: Type.Array(OverpassResultEntrySchema),
	queryArea: Type.Optional(BoundsSchema),
	busy: Type.Optional(Type.Literal(true)),
	resolvedTypes: Type.Optional(
		Type.Array(
			Type.Object({
				input: Type.String(),
				kind: Type.Union([Type.Literal("type"), Type.Literal("brand"), Type.Literal("name")]),
			}),
		),
	),
});
export type FindFeaturesToolDetails = Static<typeof FindFeaturesToolDetailsSchema>;

export const FilterToolDetailsSchema = Type.Object({
	data: Type.Array(StoredElementSchema),
	bounds: Type.Optional(BoundsSchema),
	filterStats: Type.Object({
		inputCount: Type.Number(),
		outputCount: Type.Number(),
		filteredOut: Type.Number(),
	}),
});
export type FilterToolDetails = Static<typeof FilterToolDetailsSchema>;

export const SpatialPairSchema = Type.Object({
	point: StoredElementSchema,
	target: StoredElementSchema,
	distance: Type.Number({ description: "Distance in metres." }),
});
export type SpatialPair = Static<typeof SpatialPairSchema>;

export const SpatialJoinToolDetailsSchema = Type.Object({
	data: Type.Array(SpatialPairSchema),
	stats: Type.Object({
		pointsCount: Type.Number(),
		targetsCount: Type.Number(),
		pairsFound: Type.Number(),
		pairsTruncated: Type.Boolean(),
	}),
});
export type SpatialJoinToolDetails = Static<typeof SpatialJoinToolDetailsSchema>;
