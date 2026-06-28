import { Type } from "typebox";
import type { Static } from "typebox";

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
