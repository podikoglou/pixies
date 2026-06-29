import { Result } from "better-result";
import { Type } from "typebox";
import { defineTool, parseSchema } from "./tool-module.ts";
import { throwIfAborted } from "./control-flow.ts";
import type { ToolProgress } from "./progress.ts";
import type { DisplayData } from "../functions/host-functions.ts";
import type { CodeExecutionError } from "../errors.ts";

/** Successful sandbox execution: the curated host-summary channel (model-visible), the model's own bounded stdout (console), and any map displays emitted by `display()`. */
export interface CodeExecutionSuccess {
	/** Server-authored per-primitive summaries — the model's bounded result window. */
	summary: string;
	/** The model's own `print()` output, bounded per cell (flood guard). */
	stdout: string;
	displays: DisplayData[];
}

/** Sandboxed Python execution. The server implements this with Monty; tests use stubs. */
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
		const { summary, stdout, displays } = result.value;
		// The model's result window is the curated summary, with its own bounded
		// stdout appended so short debug/len prints stay useful. `stdout` is the
		// bounded model-print channel (console); it is also the wire `details`
		// field the UI card can fall back to. Pure-computation cells (no host
		// calls, no prints) fall back to "OK".
		const text =
			[summary, stdout].filter((s) => s.length > 0).join(summary.endsWith("\n") ? "" : "\n") ||
			"OK";
		return {
			content: [{ type: "text" as const, text }],
			details: { stdout, displays },
		};
	},
});
