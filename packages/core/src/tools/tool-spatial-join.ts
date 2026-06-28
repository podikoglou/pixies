import { Type } from "typebox";
import { defineTool, parseSchema } from "./tool-module.ts";
import type { DependencyContext } from "./dependency-graph.ts";
import { resolveRef } from "./dependency-graph.ts";
import type { StoredResult } from "./result-store.ts";
import type { StoredElement } from "./stored-element.ts";
import type { ToolProgress } from "./progress.ts";
import {
	SpatialJoinToolDetailsSchema,
	type SpatialJoinToolDetails,
	type SpatialPair,
} from "./schemas.ts";
import { throwIfAborted } from "./control-flow.ts";
import { textResult, formatContentLines } from "./content.ts";

/**
 * `spatial_join` — in-memory spatial operations between two stored result
 * sets. The tool that finally makes "X near Y" expressible: fetch X and Y
 * as separate result sets (often in parallel via two `find_features` calls
 * referencing the same area), then this tool joins them by coordinate.
 *
 * Operations:
 * - `near`: for each point, all targets within `radius` (many-to-many)
 * - `nearest`: for each point, the single closest target within `radius`
 *
 * `within` (point-in-polygon) is deliberately out of scope for the
 * experiment — it requires full geometry, which means `out geom;`
 * responses that are several times larger. Documented in issue #244.
 */

const schema = Type.Object({
	operation: Type.Union([Type.Literal("near"), Type.Literal("nearest")], {
		description:
			"'near' — all targets within radius of each point (many-to-many). 'nearest' — single closest target per point within radius.",
	}),
	pointsRef: Type.String({ description: "Tool call ID of the 'left' result set." }),
	targetsRef: Type.String({ description: "Tool call ID of the 'right' result set." }),
	radius: Type.Number({
		minimum: 1,
		description:
			"Radius in metres. Required for 'near'; for 'nearest' acts as a maximum search radius.",
	}),
	maxPairs: Type.Optional(
		Type.Number({
			minimum: 1,
			description:
				"Maximum pairs returned. Guards against combinatorial explosion on 'near' with large sets. Default 1000.",
		}),
	),
});

/** Safeguard against runaway pair counts on large inputs. */
const DEFAULT_MAX_PAIRS = 1000;

export type SpatialJoinContext = DependencyContext;

/**
 * Great-circle distance between two lat/lon points, in metres. The standard
 * haversine with Earth radius 6,371,000 m. Used by both `near` and `nearest`
 * — accurate enough for sub-city-scale joins (the experiment's target).
 */
export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const R = 6_371_000;
	const toRad = (d: number) => (d * Math.PI) / 180;
	const dLat = toRad(lat2 - lat1);
	const dLon = toRad(lon2 - lon1);
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
	return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Return only elements that have both lat and lon (skip coordinate-less nodes like relation stubs). */
function withCoords(elements: StoredElement[]): StoredElement[] {
	return elements.filter(
		(el): el is StoredElement & { lat: number; lon: number } =>
			el.lat !== undefined && el.lon !== undefined,
	);
}

/** Execute the `near` operation: every target within radius of each point. */
function executeNear(
	points: StoredElement[],
	targets: StoredElement[],
	radius: number,
	maxPairs: number,
): { pairs: SpatialPair[]; truncated: boolean } {
	const pairs: SpatialPair[] = [];
	for (const point of points) {
		for (const target of targets) {
			const dist = haversineMeters(point.lat!, point.lon!, target.lat!, target.lon!);
			if (dist <= radius) {
				pairs.push({ point, target, distance: Math.round(dist) });
				if (pairs.length >= maxPairs) return { pairs, truncated: true };
			}
		}
	}
	return { pairs, truncated: false };
}

/** Execute the `nearest` operation: closest target per point, within radius. */
function executeNearest(
	points: StoredElement[],
	targets: StoredElement[],
	radius: number,
): SpatialPair[] {
	const pairs: SpatialPair[] = [];
	for (const point of points) {
		let best: SpatialPair | null = null;
		for (const target of targets) {
			const dist = haversineMeters(point.lat!, point.lon!, target.lat!, target.lon!);
			if (dist <= radius && (best === null || dist < best.distance)) {
				best = { point, target, distance: Math.round(dist) };
			}
		}
		if (best) pairs.push(best);
	}
	return pairs;
}

/** Format a pair as a pipe-delimited content line. */
function formatPair(p: SpatialPair): string {
	const pn = p.point.name ?? p.point.id;
	const tn = p.target.name ?? p.target.id;
	return `${pn} ↔ ${tn} | ${p.distance}m`;
}

/**
 * Flatten pairs into stored elements (point ∪ target, deduped by id) so a
 * downstream tool referencing this result sees a coherent element set.
 * The pair structure itself is preserved in `details.data` for the client.
 */
function pairsToStoredElements(pairs: SpatialPair[]): StoredElement[] {
	const seen = new Set<string>();
	const out: StoredElement[] = [];
	for (const p of pairs) {
		for (const el of [p.point, p.target]) {
			if (!seen.has(el.id)) {
				seen.add(el.id);
				out.push(el);
			}
		}
	}
	return out;
}

export const spatialJoinModule = defineTool<
	{ kind: "spatial_join"; pairs: SpatialPair[] },
	SpatialJoinContext,
	typeof schema,
	ToolProgress | SpatialJoinToolDetails
>({
	name: "spatial_join",
	label: "Spatial Join",
	description: `Compute spatial relationships between two prior result sets in-memory. Executes instantly — no external call. This is how "find X near Y" is expressed: fetch X and Y separately (typically in parallel via two find_features calls sharing the same area), then this tool joins them.

Operations:
- 'near' — for each point, all targets within radius (many-to-many). Pairs include distance.
- 'nearest' — single closest target per point within radius (one-to-one).

Returns pairs (point, target, distance). 'within' (polygon containment) is not supported.`,
	parameters: schema,
	detailsSchema: SpatialJoinToolDetailsSchema,
	parse: parseSchema(SpatialJoinToolDetailsSchema, (d) => ({
		kind: "spatial_join",
		pairs: d.data,
	})),
	execute: async (ctx, toolCallId, params, signal, onUpdate) => {
		throwIfAborted(signal);
		const reg = ctx.coordinator.register(toolCallId);
		let stored: StoredResult | null = null;
		let pendingCause: unknown;
		try {
			onUpdate?.({ content: [], details: { type: "running" } });
			// Resolve both refs concurrently — they're independent of each other.
			const [pointResult, targetResult] = await Promise.all([
				resolveRef(ctx, toolCallId, params.pointsRef, signal),
				resolveRef(ctx, toolCallId, params.targetsRef, signal),
			]);
			const points = withCoords(pointResult.elements);
			const targets = withCoords(targetResult.elements);
			const maxPairs = params.maxPairs ?? DEFAULT_MAX_PAIRS;

			let pairs: SpatialPair[];
			let truncated = false;
			if (params.operation === "near") {
				const r = executeNear(points, targets, params.radius, maxPairs);
				pairs = r.pairs;
				truncated = r.truncated;
			} else {
				pairs = executeNearest(points, targets, params.radius);
			}

			stored = {
				toolCallId,
				toolName: "spatial_join",
				timestamp: Date.now(),
				elements: pairsToStoredElements(pairs),
			};
			const text =
				pairs.length === 0
					? "No pairs found within radius."
					: formatContentLines(
							pairs,
							formatPair,
							(rest) =>
								`…and ${rest} more pairs. Display with display_map(pairsRef: "${toolCallId}") to see the relationships on the map.`,
						);
			return {
				...textResult(text),
				details: {
					data: pairs.map((p) => ({
						point: {
							id: p.point.id,
							...(p.point.lat !== undefined ? { lat: p.point.lat } : {}),
							...(p.point.lon !== undefined ? { lon: p.point.lon } : {}),
							...(p.point.name ? { name: p.point.name } : {}),
							...(p.point.tags ? { tags: p.point.tags } : {}),
						},
						target: {
							id: p.target.id,
							...(p.target.lat !== undefined ? { lat: p.target.lat } : {}),
							...(p.target.lon !== undefined ? { lon: p.target.lon } : {}),
							...(p.target.name ? { name: p.target.name } : {}),
							...(p.target.tags ? { tags: p.target.tags } : {}),
						},
						distance: p.distance,
					})),
					stats: {
						pointsCount: points.length,
						targetsCount: targets.length,
						pairsFound: pairs.length,
						pairsTruncated: truncated,
					},
				},
			};
		} catch (e) {
			pendingCause = e;
			throw e;
		} finally {
			reg.done(stored, stored ? undefined : pendingCause);
		}
	},
});
