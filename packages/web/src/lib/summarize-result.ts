import { summarizeToolResult, type ToolResult } from "@pixies/core";

export { type ToolResult };

export function summarizeResult(result: ToolResult): string | null {
	return summarizeToolResult(result);
}
