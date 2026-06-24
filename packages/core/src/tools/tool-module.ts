import type {
	AgentTool,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolExecutionMode,
} from "@earendil-works/pi-agent-core";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import type { NominatimClient } from "../osm/nominatim.ts";
import type { OverpassClient } from "../osm/overpass.ts";

export interface OsmClients {
	nominatim: NominatimClient;
	overpass: OverpassClient;
}

export interface ToolModule<TResult extends { kind: string }> {
	detailsSchema: TSchema;
	parse: (details: unknown) => TResult | null;
	summarize: (result: TResult) => string | null;
}

/**
 * Build a {@link ToolModule.parse} function from a TypeBox schema and a mapping
 * to the typed result. `Value.Check` both validates `details` at runtime and
 * narrows it to `Static<typeof schema>` at compile time, so `toResult` receives
 * a typed value. Returns `null` when `details` does not validate.
 *
 * @example
 *   parse: parseSchema(GeocodeToolDetailsSchema, (d) => ({ kind: "geocode", entries: d.data })),
 */
export function parseSchema<S extends TSchema, R>(
	schema: S,
	toResult: (details: Static<S>) => R,
): (details: unknown) => R | null {
	return (details) => (Value.Check(schema, details) ? toResult(details) : null);
}

/**
 * Construct a tool from its metadata plus an `execute` that receives the
 * context it depends on as its first argument. Owns no logic: it assembles an
 * {@link AgentTool} (partial-applying the context into `execute`) and
 * re-exposes the parse / summarize surface of a {@link ToolModule}.
 *
 * The returned object is both a `ToolModule<TResult>` (so it can be keyed in a
 * registry for `parseToolResult` / `summarizeToolResult`) and carries a
 * `build(ctx)` method that produces a concrete `AgentTool` once its context is
 * supplied. `createTools` is the one place that knows the `OsmClients` bag and
 * projects it into each tool's context.
 *
 * Each tool declares exactly the context it needs (`TContext`) via `execute`'s
 * first parameter — an arbitrary object the tool types itself (e.g.
 * `{ nominatim }`, `{ overpass }`, `{}`) — so single-tool tests build the tool
 * with one mock and no type-lies.
 *
 * For a tool that needs no context, pass `TContext = void`; `execute` then
 * takes a placeholder first argument (conventionally `_`) and `build()` is
 * callable with no arguments.
 *
 * @param def Tool metadata, parse/summarize surface, and an `execute` whose
 * first argument is the context this tool depends on.
 */
export function defineTool<
	TResult extends { kind: string },
	TContext,
	TParams extends TSchema,
	TDetails,
>(def: {
	name: string;
	label: string;
	description: string;
	parameters: TParams;
	executionMode?: ToolExecutionMode;
	detailsSchema: TSchema;
	parse: (details: unknown) => TResult | null;
	summarize: (result: TResult) => string | null;
	execute: (
		ctx: TContext,
		toolCallId: string,
		params: Static<TParams>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails>,
	) => Promise<AgentToolResult<TDetails>>;
}) {
	return {
		detailsSchema: def.detailsSchema,
		parse: def.parse,
		summarize: def.summarize,
		/**
		 * Build a concrete {@link AgentTool} by partial-applying the context
		 * this tool depends on into `execute`. For context-less tools
		 * (`TContext = void`) call with no arguments: `build()`.
		 */
		build: (ctx: TContext): AgentTool<TParams, TDetails> => ({
			name: def.name,
			label: def.label,
			description: def.description,
			parameters: def.parameters,
			execute: (toolCallId, params, signal, onUpdate) =>
				def.execute(ctx, toolCallId, params, signal, onUpdate),
			...(def.executionMode ? { executionMode: def.executionMode } : {}),
		}),
	};
}
