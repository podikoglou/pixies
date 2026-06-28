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
			"Python code to execute. Call the pre-loaded global functions directly — no imports, no await.",
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
		"Execute Python code in a sandboxed interpreter (Monty). The functions geocode, find_features, filter, spatial_join, display, reverse_geocode, overpass_query, haversine, and bounds_of are pre-loaded as globals — do NOT import them, do NOT use await. There is no import system, no standard library. Call display() to show results on the map.",
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
