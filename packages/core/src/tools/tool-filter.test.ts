/// <reference types="bun" />
import { test, expect } from "bun:test";
import { filterModule } from "./tool-filter.ts";
import { TurnCoordinator } from "./dependency-graph.ts";
import { ResultStore, type StoredResult } from "./result-store.ts";
import type { StoredElement } from "./stored-element.ts";

/** Test fixture: a town-like element with population, plus a name. */
function town(
	id: string,
	name: string,
	population: string,
	extras: Record<string, string> = {},
): StoredElement {
	return {
		id,
		lat: 0,
		lon: 0,
		name,
		tags: { name, population, ...extras },
	};
}

const upstream: StoredResult = {
	toolCallId: "tc_upstream",
	toolName: "find_features",
	timestamp: 0,
	elements: [
		town("node/1", "Small", "5,000"),
		town("node/2", "Medium", "15000"),
		town("node/3", "Big", "30 000"),
		town("node/4", "Huge", "100000"),
		town("node/5", "EmptyPop", ""), // no usable population
		town("node/6", "Stockholm", "2,000,000"),
	],
};

function makeTool() {
	const coordinator = new TurnCoordinator();
	const store = new ResultStore();
	store.set(upstream);
	return {
		tool: filterModule.build({ coordinator, store }),
	};
}

async function runWhere(where: string) {
	const { tool } = makeTool();
	const r = await tool.execute("tc_filter", { queryRef: "tc_upstream", where }, undefined);
	if (!("details" in r) || !("filterStats" in r.details))
		throw new Error("unexpected result shape");
	return r.details;
}

test("numeric comparison — population <= 30000 catches OSM's space- and comma-thousand formats", async () => {
	const d = await runWhere("population <= 30000");
	expect(d.filterStats.outputCount).toBe(3); // Small (5,000), Medium (15000), Big (30 000)
	expect(d.data.map((e) => e.name).sort()).toEqual(["Big", "Medium", "Small"]);
});

test("numeric comparison — population > 30000", async () => {
	const d = await runWhere("population > 30000");
	expect(d.data.map((e) => e.name).sort()).toEqual(["Huge", "Stockholm"]);
});

test("IS NULL — keeps elements missing the tag (EmptyPop has empty-string, not absent)", async () => {
	const d = await runWhere("mayor IS NULL");
	expect(d.filterStats.outputCount).toBe(upstream.elements.length);
});

test("IS NOT NULL — keeps elements that have the tag", async () => {
	const d = await runWhere("population IS NOT NULL");
	// All elements have a `population` key, even EmptyPop (value "").
	expect(d.filterStats.outputCount).toBe(upstream.elements.length);
});

test("regex literal — case-insensitive name match", async () => {
	const d = await runWhere("name =~ /stockholm/i");
	expect(d.data.map((e) => e.name)).toEqual(["Stockholm"]);
});

test("AND/OR precedence — OR binds looser than AND", async () => {
	const d = await runWhere("population < 10000 OR population > 50000");
	expect(d.data.map((e) => e.name).sort()).toEqual(["Huge", "Small", "Stockholm"]);
});

test("parentheses — override default precedence", async () => {
	// (Small OR Huge) AND name =~ /^S/ → Small + Stockholm.
	const d = await runWhere("(population < 10000 OR population > 50000) AND name =~ /^S/");
	expect(d.data.map((e) => e.name).sort()).toEqual(["Small", "Stockholm"]);
});

test("!= — excludes by exact string value", async () => {
	const d = await runWhere("name != 'Stockholm'");
	expect(d.filterStats.outputCount).toBe(upstream.elements.length - 1);
});

test("error — unbalanced parens surface as a tool error", async () => {
	const { tool } = makeTool();
	expect(
		tool.execute("tc_filter", { queryRef: "tc_upstream", where: "(population < 30000" }, undefined),
	).rejects.toThrow(/expected '\)'/);
});

test("error — non-numeric value in a numeric comparison is rejected", async () => {
	const { tool } = makeTool();
	expect(
		tool.execute("tc_filter", { queryRef: "tc_upstream", where: "name < 'foo'" }, undefined),
	).rejects.toThrow(/requires a number/);
});

test("sortBy — descending numeric sort via '-population'", async () => {
	const { tool } = makeTool();
	const r = await tool.execute(
		"tc_filter",
		{ queryRef: "tc_upstream", sortBy: "-population" },
		undefined,
	);
	if (!("details" in r) || !("filterStats" in r.details)) throw new Error("unexpected shape");
	// EmptyPop's population parses to null and sorts to the end.
	expect(r.details.data.at(-1)?.name).toBe("EmptyPop");
	expect(r.details.data[0]?.name).toBe("Stockholm");
});

test("limit — keeps the first N after filtering", async () => {
	const { tool } = makeTool();
	const r = await tool.execute(
		"tc_filter",
		{ queryRef: "tc_upstream", where: "population < 30000", limit: 1 },
		undefined,
	);
	if (!("details" in r) || !("filterStats" in r.details)) throw new Error("unexpected shape");
	expect(r.details.data).toHaveLength(1);
});

test("distinct — deduplicates by element ID", async () => {
	const coordinator = new TurnCoordinator();
	const store = new ResultStore();
	store.set({
		toolCallId: "dup",
		toolName: "find_features",
		timestamp: 0,
		elements: [
			{ id: "node/1", lat: 0, lon: 0, tags: { a: "1" } },
			{ id: "node/1", lat: 0, lon: 0, tags: { a: "1" } },
			{ id: "node/2", lat: 0, lon: 0 },
		],
	});
	const tool = filterModule.build({ coordinator, store });
	const r = await tool.execute("tc_filter", { queryRef: "dup", distinct: true }, undefined);
	if (!("details" in r) || !("filterStats" in r.details)) throw new Error("unexpected shape");
	expect(r.details.data).toHaveLength(2);
});

// --- End-to-end intra-turn dependency (issue #244, review H7) ---
// Exercises the load-bearing path: filter.execute → resolveRef →
// coordinator.awaitResult → upstream.done. Other tests pre-populate the
// store; this one proves filter actually awaits an in-flight upstream.

test("intra-turn ref — filter awaits an in-flight upstream and resolves when it lands", async () => {
	const coordinator = new TurnCoordinator();
	const store = new ResultStore();
	const tool = filterModule.build({ coordinator, store });

	// Register an upstream but don't settle it yet.
	const upstreamReg = coordinator.register("upstream");
	const upstreamElements: StoredElement[] = [
		{ id: "node/1", lat: 0, lon: 0, tags: { population: "5,000" } },
		{ id: "node/2", lat: 0, lon: 0, tags: { population: "50,000" } },
	];

	// Kick off filter; it should pending on the upstream's result.
	const filterPromise = tool.execute(
		"tc_filter",
		{ queryRef: "upstream", where: "population < 30000" },
		undefined,
	);
	// Let filter's synchronous prefix run and reach `awaitResult`.
	await Promise.resolve();
	await Promise.resolve();

	// Settle the upstream with a real StoredResult.
	upstreamReg.done({
		toolCallId: "upstream",
		toolName: "find_features",
		timestamp: 0,
		elements: upstreamElements,
	});

	const r = await filterPromise;
	if (!("details" in r) || !("filterStats" in r.details)) throw new Error("unexpected shape");
	expect(r.details.data.map((e) => e.id)).toEqual(["node/1"]);
});

test("intra-turn ref — UpstreamFailedError with the real cause when upstream fails", async () => {
	const coordinator = new TurnCoordinator();
	const store = new ResultStore();
	const tool = filterModule.build({ coordinator, store });

	const upstreamReg = coordinator.register("upstream");
	const filterPromise = tool.execute(
		"tc_filter",
		{ queryRef: "upstream", where: "population < 30000" },
		undefined,
	);
	await Promise.resolve();
	await Promise.resolve();

	// Upstream fails with a tagged error.
	const upstreamErr = new (class extends Error {
		readonly _tag = "OverpassBusy";
	})("overpass overloaded");
	upstreamReg.done(null, upstreamErr);

	// filter's execute re-throws UpstreamFailedError with the cause threaded
	// through the coordinator — the framework would mark this as isError=true
	// and surface the text to the model.
	await expect(filterPromise).rejects.toThrow(/overpass overloaded/);
});
