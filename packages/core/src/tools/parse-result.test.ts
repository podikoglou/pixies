/// <reference types="bun" />
import { test, expect } from "bun:test";
import { parseToolResult } from "./index.ts";

test("parseToolResult execute_code — valid details with stdout and displays", () => {
	const details = {
		stdout: 'geocode("Eiffel Tower") → Tour Eiffel (48.858, 2.295)\n',
		displays: [{ markers: [{ lat: 48.858, lon: 2.295, label: "Tour Eiffel" }] }],
	};
	const result = parseToolResult("execute_code", details);
	expect(result.kind).toBe("execute_code");
	if (result.kind !== "execute_code") return;
	expect(result.stdout).toContain("Tour Eiffel");
	expect(result.displays).toHaveLength(1);
});

test("parseToolResult execute_code — empty stdout", () => {
	const details = { stdout: "", displays: [] };
	const result = parseToolResult("execute_code", details);
	expect(result.kind).toBe("execute_code");
});

test("parseToolResult execute_code — null/undefined details returns empty", () => {
	expect(parseToolResult("execute_code", null).kind).toBe("empty");
	expect(parseToolResult("execute_code", undefined).kind).toBe("empty");
});

test("parseToolResult unknown tool returns empty", () => {
	expect(parseToolResult("nonexistent_tool", { data: [] }).kind).toBe("empty");
});
