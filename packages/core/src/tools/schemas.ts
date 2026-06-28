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
 * Shared `tags` parameter schema used by both `find_features` and `filter`.
 * Same shape, same op enum — extracting it keeps the two tool surfaces
 * byte-identical and lets the model reuse the same expressions.
 */
export const TagClauseSchema = Type.Object({
	key: Type.String({ description: "OSM tag key, e.g. 'amenity' or 'population'." }),
	value: Type.Optional(
		Type.String({ description: "Tag value (required unless op is 'exists'/'notexists')." }),
	),
	op: Type.Optional(
		Type.Union(
			[
				Type.Literal("eq"),
				Type.Literal("neq"),
				Type.Literal("regex"),
				Type.Literal("iregex"),
				Type.Literal("exists"),
				Type.Literal("notexists"),
			],
			{
				description:
					"Comparison operator. Default 'eq'. eq=exact, neq=not equal, regex=case-sensitive, iregex=case-insensitive, exists=key present, notexists=key absent.",
			},
		),
	),
});
export type TagClause = Static<typeof TagClauseSchema>;
