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
