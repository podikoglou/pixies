/// <reference types="bun" />
import { test, expect } from "bun:test";
import { TurnCoordinator, resolveRef } from "./dependency-graph.ts";
import { ResultStore } from "./result-store.ts";
import { UnknownRefError, CircularRefError, UpstreamFailedError } from "../errors.ts";
import type { StoredResult } from "./result-store.ts";

const stored = (id: string): StoredResult => ({
	toolCallId: id,
	toolName: "find_features",
	timestamp: 0,
	elements: [{ id: `${id}/0`, lat: 0, lon: 0 }],
});

test("awaitResult — resolves when the upstream calls done(result)", async () => {
	const coord = new TurnCoordinator();
	const store = new ResultStore();
	const reg = coord.register("upstream");
	const waiter = resolveRef({ coordinator: coord, store }, "downstream", "upstream");
	// Let the await actually start.
	await Promise.resolve();
	reg.done(stored("upstream"));
	const result = await waiter;
	expect(result.toolCallId).toBe("upstream");
});

test("awaitResult — UnknownRefError when the ref matches nothing", async () => {
	const coord = new TurnCoordinator();
	const store = new ResultStore();
	await expect(
		resolveRef({ coordinator: coord, store }, "downstream", "nonexistent"),
	).rejects.toBeInstanceOf(UnknownRefError);
});

test("awaitResult — cross-turn ref resolves from the store without waiting", async () => {
	const coord = new TurnCoordinator();
	const store = new ResultStore();
	store.set(stored("prior_turn"));
	const result = await resolveRef({ coordinator: coord, store }, "downstream", "prior_turn");
	expect(result.toolCallId).toBe("prior_turn");
});

test("awaitResult — UpstreamFailedError when upstream resolves with null", async () => {
	const coord = new TurnCoordinator();
	const store = new ResultStore();
	const reg = coord.register("upstream");
	const waiter = resolveRef({ coordinator: coord, store }, "downstream", "upstream");
	await Promise.resolve();
	reg.done(null);
	await expect(waiter).rejects.toBeInstanceOf(UpstreamFailedError);
});

test("cycle — direct self-reference is rejected", async () => {
	const coord = new TurnCoordinator();
	coord.register("a");
	await expect(coord.awaitResult("a", "a")).rejects.toBeInstanceOf(CircularRefError);
});

test("cycle — mutual dependency is detected lazily and never deadlocks", async () => {
	const coord = new TurnCoordinator();
	const regA = coord.register("a");
	const regB = coord.register("b");
	const signal = AbortSignal.timeout(500);

	// a waits for b, then b waits for a — b's wait should reject with cycle.
	const aPromise = coord.awaitResult("b", "a", signal).catch((e: unknown) => e);
	// Let a's wait edge register before b starts waiting.
	await Promise.resolve();
	const bResult = await coord.awaitResult("a", "b", signal).catch((e: unknown) => e);
	expect(bResult).toBeInstanceOf(CircularRefError);

	// Clean up so the test doesn't hang on the open aPromise.
	regA.done(null);
	regB.done(null);
	await aPromise;
});

test("abort — waiter wakes when the signal aborts", async () => {
	const coord = new TurnCoordinator();
	const store = new ResultStore();
	coord.register("upstream");
	const ctrl = new AbortController();
	const waiter = resolveRef({ coordinator: coord, store }, "downstream", "upstream", ctrl.signal);
	// Let the await register its listener.
	await Promise.resolve();
	ctrl.abort(new Error("aborted"));
	await expect(waiter).rejects.toThrow(/aborted/);
});

test("register — duplicate ID in the same turn throws", () => {
	const coord = new TurnCoordinator();
	coord.register("a");
	expect(() => coord.register("a")).toThrow(/duplicate registration/);
});

test("isInFlight — true while registered, false after done microtask settles", async () => {
	const coord = new TurnCoordinator();
	const reg = coord.register("a");
	expect(coord.isInFlight("a")).toBe(true);
	reg.done(stored("a"));
	// The cleanup runs on the next microtask.
	await new Promise((r) => queueMicrotask(r));
	expect(coord.isInFlight("a")).toBe(false);
});

test("done is idempotent — calling twice does not throw or double-resolve", async () => {
	const coord = new TurnCoordinator();
	const reg = coord.register("a");
	reg.done(stored("a"));
	expect(() => reg.done(stored("a"))).not.toThrow();
});
