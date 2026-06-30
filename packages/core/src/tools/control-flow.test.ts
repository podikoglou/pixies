/// <reference types="bun" />
import { test, expect } from "bun:test";
import { ToolAbortedError } from "../errors.ts";
import { throwIfAborted, forwardProgress } from "./control-flow.ts";
import type { ToolProgress } from "./progress.ts";

// ---- throwIfAborted ---------------------------------------------------------

test("throwIfAborted: no signal does not throw", () => {
	expect(() => throwIfAborted(undefined)).not.toThrow();
});

test("throwIfAborted: non-aborted signal does not throw", () => {
	const controller = new AbortController();
	expect(() => throwIfAborted(controller.signal)).not.toThrow();
});

test("throwIfAborted: already-aborted signal throws ToolAbortedError", () => {
	const controller = new AbortController();
	controller.abort();
	expect(() => throwIfAborted(controller.signal)).toThrow(ToolAbortedError);
});

// ---- forwardProgress --------------------------------------------------------

test("forwardProgress: forwards progress as a partial result with empty content", () => {
	const updates: { content: unknown[]; details: ToolProgress }[] = [];
	const onProgress = forwardProgress((update) => updates.push(update));
	const progress: ToolProgress = { type: "running" };
	onProgress(progress);
	expect(updates).toEqual([{ content: [], details: progress }]);
});

test("forwardProgress: safe no-op when onUpdate is absent", () => {
	const onProgress = forwardProgress(undefined);
	expect(() => onProgress({ type: "running" })).not.toThrow();
});
