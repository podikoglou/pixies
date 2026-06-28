import type { AgentTool } from "@earendil-works/pi-agent-core";
import { executeCodeModule } from "./tool-execute-code.ts";
import type { ToolModule } from "./tool-module.ts";
import type { CodeExecutor } from "./tool-execute-code.ts";

export type { ToolProgress } from "./progress.ts";
export { ToolProgressSchema, isToolProgress } from "./progress.ts";

export { ExecuteCodeDetailsSchema } from "./tool-execute-code.ts";
export type {
	CodeExecutor,
	CodeExecutionSuccess,
	ExecuteCodeDetails,
} from "./tool-execute-code.ts";
export type {
	HostContext,
	Feature,
	GeocodeResult,
	FindFeaturesResult,
	SpatialPair,
	DisplayData,
} from "./host-functions.ts";

export {
	geocodeHost,
	reverseGeocodeHost,
	findFeaturesHost,
	filterHost,
	spatialJoinHost,
	overpassQueryHost,
} from "./host-functions.ts";

const TOOL_MODULES = {
	execute_code: executeCodeModule,
} as const;

type ToolName = keyof typeof TOOL_MODULES;

export interface CreateToolsInputs {
	executor: CodeExecutor;
}

/** Build the agent tool set from injected dependencies. */
export function createTools(inputs: CreateToolsInputs): AgentTool[] {
	const builds: { [K in keyof typeof TOOL_MODULES]: AgentTool } = {
		execute_code: executeCodeModule.build(inputs.executor),
	};
	return Object.values(builds);
}

type ExtractResult<T> = T extends ToolModule<infer R> ? R : never;

type ToolResultFromModules = ExtractResult<(typeof TOOL_MODULES)[keyof typeof TOOL_MODULES]>;

export type ToolResult = ToolResultFromModules | { kind: "empty" };

/** Parse tool details into a typed result. Unknown tools return `{ kind: "empty" }`. */
export function parseToolResult(toolName: string, details: unknown): ToolResult {
	const mod = TOOL_MODULES[toolName as ToolName];
	if (!mod) return { kind: "empty" };
	return mod.parse(details) ?? { kind: "empty" };
}

export function isBusyResult(details: unknown): boolean {
	return (details as Record<string, unknown> | null | undefined)?.busy === true;
}

const DATA_FETCH_TOOLS = ["execute_code"] as const;

export function toolResultCount(toolName: string, details: unknown): number | undefined {
	if (!(DATA_FETCH_TOOLS as readonly string[]).includes(toolName)) return undefined;
	if (isBusyResult(details)) return undefined;
	const parsed = parseToolResult(toolName, details);
	if (parsed.kind === "execute_code") {
		return parsed.displays.reduce((n, d) => n + (d.features?.length ?? d.markers?.length ?? 0), 0);
	}
	return 0;
}
