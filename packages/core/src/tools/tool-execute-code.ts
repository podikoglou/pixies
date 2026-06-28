import { Result } from "better-result";
import { Type } from "typebox";
import { defineTool, parseSchema } from "./tool-module.ts";
import { throwIfAborted } from "./control-flow.ts";
import type { ToolProgress } from "./progress.ts";
import type { DisplayData } from "./host-functions.ts";
import type { CodeExecutionError } from "../errors.ts";

export interface CodeExecutionSuccess {
	stdout: string;
	displays: DisplayData[];
}

export interface CodeExecutor {
	execute(
		code: string,
		options: {
			signal?: AbortSignal;
			onDisplay?: (data: DisplayData) => void;
			onProgress?: (message: string) => void;
		},
	): Promise<Result<CodeExecutionSuccess, CodeExecutionError>>;
}

export interface ExecuteCodeDetails {
	stdout: string;
	displays: DisplayData[];
}

export const ExecuteCodeDetailsSchema = Type.Object({
	stdout: Type.String(),
	displays: Type.Array(Type.Unknown()),
});

const schema = Type.Object({
	code: Type.String({
		description:
			"Python code to execute. Call the provided functions (geocode, find_features, filter, spatial_join, display, reverse_geocode, overpass_query) to answer spatial questions. Use await for async functions (geocode, find_features, overpass_query). filter and spatial_join are synchronous. Call display() to show results on the map.",
	}),
});

export const executeCodeModule = defineTool<
	{ kind: "execute_code"; stdout: string; displays: DisplayData[] },
	CodeExecutor,
	typeof schema,
	ToolProgress | ExecuteCodeDetails
>({
	name: "execute_code",
	label: "Execute Code",
	description:
		"Execute Python code that calls spatial functions to answer the user's question. The code runs in a sandboxed interpreter with access to geocode, find_features, filter, spatial_join, display, reverse_geocode, and overpass_query. Variables persist across calls within the same conversation. Use print() to inspect results.",
	parameters: schema,
	detailsSchema: ExecuteCodeDetailsSchema,
	parse: parseSchema(ExecuteCodeDetailsSchema, (d) => ({
		kind: "execute_code",
		stdout: d.stdout,
		displays: d.displays as DisplayData[],
	})),
	execute: async (executor, _toolCallId, params, signal, onUpdate) => {
		throwIfAborted(signal);
		onUpdate?.({ content: [], details: { type: "running" } });
		const result = await executor.execute(params.code, {
			signal,
			onProgress: () => {},
		});
		if (Result.isError(result)) throw result.error;
		const { stdout, displays } = result.value;
		return {
			content: [{ type: "text" as const, text: stdout || "(no output)" }],
			details: { stdout, displays },
		};
	},
});
