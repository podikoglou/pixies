/// <reference types="bun" />
import { test, expect } from "bun:test";
import { textResult, formatContentLines } from "./tool-helpers.ts";
import { MAX_CONTENT_LINES } from "./limits.ts";

test("textResult: builds single text-block content", () => {
	expect(textResult("hi")).toEqual({ content: [{ type: "text", text: "hi" }] });
});

test("formatContentLines: under limit — all rows, no footer", () => {
	expect(formatContentLines([1, 2, 3], (n) => `row${n}`)).toBe("row1\nrow2\nrow3");
});

test("formatContentLines: empty rows — empty string, no footer", () => {
	expect(formatContentLines([], (n) => `${n}`)).toBe("");
});

test("formatContentLines: exactly at limit — no footer", () => {
	const rows = Array.from({ length: MAX_CONTENT_LINES }, (_, i) => i);
	const out = formatContentLines(rows, (n) => `r${n}`);
	expect(out.split("\n").length).toBe(MAX_CONTENT_LINES);
	expect(out).not.toInclude("…and");
});

test("formatContentLines: over limit — sliced + default footer", () => {
	const rows = Array.from({ length: MAX_CONTENT_LINES + 10 }, (_, i) => i);
	const out = formatContentLines(rows, (n) => `r${n}`);
	const lines = out.split("\n");
	expect(lines.length).toBe(MAX_CONTENT_LINES + 1);
	expect(lines[MAX_CONTENT_LINES]).toBe("…and 10 more results.");
});

test("formatContentLines: custom footer overrides the default", () => {
	const rows = Array.from({ length: MAX_CONTENT_LINES + 2 }, (_, i) => i);
	const out = formatContentLines(
		rows,
		(n) => `r${n}`,
		(rest) => `footer#${rest}`,
	);
	expect(out.split("\n")[MAX_CONTENT_LINES]).toBe("footer#2");
});
