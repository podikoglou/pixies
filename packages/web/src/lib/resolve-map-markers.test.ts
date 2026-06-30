/// <reference types="bun" />
import { test, expect } from "bun:test";
import type { DisplayData } from "@pixies/core";
import { displaysToMarkers, displaysToPolylines, displaysToBounds } from "./resolve-map-markers.ts";

// --- displaysToMarkers ---

test("displaysToMarkers — flattens the explicit markers field", () => {
	const displays: DisplayData[] = [
		{
			markers: [
				{ lat: 1, lon: 2, label: "A" },
				{ lat: 3, lon: 4 },
			],
		},
	];
	expect(displaysToMarkers(displays)).toEqual([
		{ lat: 1, lon: 2, label: "A" },
		{ lat: 3, lon: 4 },
	]);
});

test("displaysToMarkers — unnamed markers omit the label key", () => {
	const displays: DisplayData[] = [{ markers: [{ lat: 1, lon: 2 }] }];
	const [marker] = displaysToMarkers(displays);
	expect(marker).toBeDefined();
	expect("label" in marker!).toBe(false);
});

test("displaysToMarkers — converts features with coords, skips those without", () => {
	const displays: DisplayData[] = [
		{
			features: [
				{ id: "node/1", lat: 59.3, lon: 18.1, name: "Cafe A" },
				{ id: "way/2", lat: 59.4, lon: 18.2 },
				{ id: "relation/3" },
			],
		},
	];
	expect(displaysToMarkers(displays)).toEqual([
		{ lat: 59.3, lon: 18.1, label: "Cafe A" },
		{ lat: 59.4, lon: 18.2 },
	]);
});

test("displaysToMarkers — pair points and targets become markers, deduped by id", () => {
	const displays: DisplayData[] = [
		{
			pairs: [
				{
					point: { id: "L1", lat: 0, lon: 0, name: "LIDL" },
					target: { id: "I1", lat: 0.01, lon: 0.01, name: "IKEA" },
					distance: 1500,
				},
				{
					point: { id: "L2", lat: 1, lon: 1 },
					target: { id: "I1", lat: 1.01, lon: 1.01 },
					distance: 1500,
				},
			],
		},
	];
	expect(displaysToMarkers(displays)).toEqual([
		{ lat: 0, lon: 0, label: "LIDL" },
		{ lat: 0.01, lon: 0.01, label: "IKEA" },
		{ lat: 1, lon: 1 },
	]);
});

test("displaysToMarkers — flattens across multiple displays", () => {
	const displays: DisplayData[] = [
		{ markers: [{ lat: 1, lon: 1 }] },
		{ features: [{ id: "n/2", lat: 2, lon: 2 }] },
	];
	expect(displaysToMarkers(displays)).toHaveLength(2);
});

test("displaysToMarkers — empty displays → empty array", () => {
	expect(displaysToMarkers([])).toEqual([]);
});

// --- displaysToPolylines ---

test("displaysToPolylines — one polyline per pair", () => {
	const displays: DisplayData[] = [
		{
			pairs: [
				{
					point: { id: "a", lat: 0, lon: 0 },
					target: { id: "b", lat: 1, lon: 1 },
					distance: 10,
				},
				{
					point: { id: "c", lat: 2, lon: 2 },
					target: { id: "d", lat: 3, lon: 3 },
					distance: 20,
				},
			],
		},
	];
	const polylines = displaysToPolylines(displays);
	expect(polylines).toHaveLength(2);
	expect(polylines[0]).toEqual({ from: { lat: 0, lon: 0 }, to: { lat: 1, lon: 1 } });
});

test("displaysToPolylines — skips pairs missing coordinates", () => {
	const displays: DisplayData[] = [
		{
			pairs: [
				{
					point: { id: "a" },
					target: { id: "b", lat: 1, lon: 1 },
					distance: 10,
				},
				{
					point: { id: "c", lat: 2, lon: 2 },
					target: { id: "d", lat: 3, lon: 3 },
					distance: 20,
				},
			],
		},
	];
	expect(displaysToPolylines(displays)).toHaveLength(1);
});

test("displaysToPolylines — no pairs → empty array", () => {
	expect(displaysToPolylines([{ markers: [{ lat: 1, lon: 1 }] }])).toEqual([]);
});

// --- displaysToBounds ---

test("displaysToBounds — returns the first bounds found", () => {
	const bounds = { minlat: 1, minlon: 2, maxlat: 3, maxlon: 4 };
	expect(displaysToBounds([{ markers: [] }, { bounds }])).toEqual(bounds);
});

test("displaysToBounds — null when no display carries bounds", () => {
	expect(displaysToBounds([{ markers: [{ lat: 1, lon: 1 }] }])).toBeNull();
	expect(displaysToBounds([])).toBeNull();
});
