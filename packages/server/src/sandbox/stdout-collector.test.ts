/// <reference types="bun" />
import { test, expect } from "bun:test";
import { StdoutCollector } from "./stdout-collector.ts";

test("StdoutCollector — small prints pass through unchanged", () => {
	const c = new StdoutCollector(100);
	c.push("len: ");
	c.push("12");
	c.push("\n");
	expect(c.finish()).toBe("len: 12\n");
});

test("StdoutCollector — a single oversized fragment is capped to the budget", () => {
	const c = new StdoutCollector(50);
	c.push("X".repeat(10_000)); // print(features) → one huge fragment
	const out = c.finish();
	// stored body is at most the budget, then the marker line
	expect(out.length).toBeLessThan(200);
	expect(out).toContain("[stdout truncated");
	expect(out).toContain("~9950 chars omitted");
});

test("StdoutCollector — fragments after the budget are counted but not stored", () => {
	const c = new StdoutCollector(5);
	c.push("hello"); // fills the budget exactly
	c.push(" world"); // over budget — dropped, but counted
	const out = c.finish();
	expect(out.startsWith("hello")).toBe(true);
	expect(out).toContain("[stdout truncated");
	expect(out).toContain("~6 chars omitted"); // " world" = 6
});

test("StdoutCollector — no marker when under budget", () => {
	const c = new StdoutCollector(1000);
	c.push("just a short line\n");
	expect(c.finish()).not.toContain("[stdout truncated");
});

test("StdoutCollector — budget 0 truncates immediately and reports total", () => {
	const c = new StdoutCollector(0);
	c.push("anything");
	expect(c.finish()).toContain("[stdout truncated");
	expect(c.finish()).toContain("~8 chars omitted");
});
