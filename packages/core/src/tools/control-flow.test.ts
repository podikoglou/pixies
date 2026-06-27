/// <reference types="bun" />
import { test, expect } from "bun:test";
import { Result } from "better-result";
import { NominatimBusyError, NominatimHttpError } from "../clients/nominatim.ts";
import { ToolAbortedError } from "../errors.ts";
import { throwIfAborted, forwardProgress, recoverBusyOrThrow } from "./control-flow.ts";
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

// ---- recoverBusyOrThrow -----------------------------------------------------

test("recoverBusyOrThrow: returns the success value on Ok", () => {
	const success = { content: [], details: { data: [1, 2] } };
	expect(
		recoverBusyOrThrow(Result.ok(success), "NominatimBusy", {
			content: [],
			details: { busy: true },
		}),
	).toBe(success);
});

test("recoverBusyOrThrow: returns the busy fallback when the error tag matches", () => {
	const result = Result.err(new NominatimBusyError({ status: 503 }));
	const busy = { content: [], details: { busy: true } };
	expect(recoverBusyOrThrow(result, "NominatimBusy", busy)).toBe(busy);
});

test("recoverBusyOrThrow: re-throws the original error (not a wrapper) when the tag does not match", () => {
	const original = new NominatimHttpError({ message: "Network failure" });
	try {
		recoverBusyOrThrow(Result.err(original), "NominatimBusy", {
			content: [],
			details: { busy: true },
		});
		expect.unreachable("should have thrown");
	} catch (err) {
		expect(err).toBe(original);
		expect(err).toBeInstanceOf(NominatimHttpError);
	}
});
