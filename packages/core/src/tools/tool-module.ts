import type { AgentTool, ToolExecutionMode } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
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
 * Construct a tool from its metadata plus a constructor-factory that binds the
 * single client the tool depends on. Owns no logic: it assembles an
 * {@link AgentTool} from the factory's `execute` and re-exposes the parse /
 * summarize surface of a {@link ToolModule}.
 *
 * The returned object is both a `ToolModule<TResult>` (so it can be keyed in a
 * registry for `parseToolResult` / `summarizeToolResult`) and carries a
 * `build(client)` method that produces a concrete `AgentTool` once its client
 * is supplied. `createTools` is the one place that knows the `OsmClients` bag
 * and calls `build` with the right client per tool.
 *
 * Each tool declares exactly the client it needs (`TClient`) — never the whole
 * bag — so single-tool tests build the tool with one mock and no type-lies.
 *
 * For a tool that needs no client, pass `TClient = void` and a `factory: () =>
 * execute`; `build()` is then callable with no arguments.
 *
 * @param def Tool metadata, parse/summarize surface, and a factory that turns
 * the client it needs into the tool's `execute`.
 */
export function defineTool<
	TResult extends { kind: string },
	TClient,
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
	factory: (client: TClient) => AgentTool<TParams, TDetails>["execute"];
}) {
	const assemble = (client: TClient): AgentTool<TParams, TDetails> => ({
		name: def.name,
		label: def.label,
		description: def.description,
		parameters: def.parameters,
		execute: def.factory(client),
		...(def.executionMode ? { executionMode: def.executionMode } : {}),
	});
	return {
		name: def.name,
		label: def.label,
		description: def.description,
		parameters: def.parameters,
		...(def.executionMode ? { executionMode: def.executionMode } : {}),
		detailsSchema: def.detailsSchema,
		parse: def.parse,
		summarize: def.summarize,
		/**
		 * Build a concrete {@link AgentTool} by injecting the single client this
		 * tool depends on. For client-less tools (`TClient = void`) call with no
		 * arguments: `build()`.
		 */
		build: (client: TClient): AgentTool<TParams, TDetails> => assemble(client),
	};
}
