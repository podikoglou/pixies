import { Result } from "better-result";
import { Type } from "typebox";
import type { NominatimClient } from "../clients/nominatim.ts";
import { formatNominatimResult, NOMINATIM_BUSY_MESSAGE } from "../clients/nominatim.ts";
import { nominatimResultToData } from "./geocode-entry.ts";
import {
	ReverseGeocodeToolDetailsSchema,
	type GeocodeResultEntry,
	type ReverseGeocodeToolDetails,
} from "./schemas.ts";
import { defineTool, parseSchema } from "./tool-module.ts";
import { textResult } from "./content.ts";
import { throwIfAborted, recoverBusyOrThrow } from "./control-flow.ts";

const schema = Type.Object({
	lat: Type.Number({ description: "Latitude" }),
	lon: Type.Number({ description: "Longitude" }),
	zoom: Type.Optional(
		Type.Number({
			description:
				"Address granularity 0-18 (18=building, 14=street, 10=suburb, 3=country). Default 18.",
		}),
	),
});

export const reverseGeocodeModule = defineTool<
	{ kind: "reverse_geocode"; entry: GeocodeResultEntry },
	{ nominatim: NominatimClient },
	typeof schema,
	ReverseGeocodeToolDetails | { busy: true } | undefined
>({
	name: "reverse_geocode",
	label: "Reverse geocode",
	description:
		"Reverse geocode coordinates to a place name and address using Nominatim. Returns display_name, address breakdown, and OSM element reference. Use for 'what is at these coordinates' queries.",
	parameters: schema,
	executionMode: "sequential",
	detailsSchema: ReverseGeocodeToolDetailsSchema,
	parse: parseSchema(ReverseGeocodeToolDetailsSchema, (d) => ({
		kind: "reverse_geocode",
		entry: d.data,
	})),
	execute: async ({ nominatim }, _toolCallId, params, signal, _onUpdate) => {
		throwIfAborted(signal);
		const result = await Result.gen(async function* () {
			const result = yield* Result.await(
				nominatim.reverse(params.lat, params.lon, { zoom: params.zoom }, signal),
			);
			if (!result || !result.display_name) {
				return Result.ok({
					...textResult("No results."),
					details: undefined,
				});
			}
			return Result.ok({
				...textResult(formatNominatimResult(result)),
				details: { data: nominatimResultToData(result) },
			});
		});
		return recoverBusyOrThrow(result, "NominatimBusy", {
			...textResult(NOMINATIM_BUSY_MESSAGE),
			details: { busy: true },
		});
	},
});
