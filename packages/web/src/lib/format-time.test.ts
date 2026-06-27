/// <reference types="bun" />
import { test, expect } from "bun:test";
import { formatTime } from "./format-time.ts";

test("sub-second durations render as rounded milliseconds", () => {
	expect(formatTime(0)).toBe("0ms");
	expect(formatTime(850)).toBe("850ms");
	expect(formatTime(999)).toBe("999ms");
});

test("the 1000ms boundary falls into the seconds band", () => {
	expect(formatTime(1000)).toBe("1.0s");
});

test("seconds band renders to one decimal place", () => {
	expect(formatTime(2300)).toBe("2.3s");
	expect(formatTime(59999)).toBe("60.0s");
});

test("the 60000ms boundary falls into the minutes band", () => {
	expect(formatTime(60000)).toBe("1m 0s");
});

test("minutes band renders whole minutes plus rounded seconds", () => {
	expect(formatTime(90000)).toBe("1m 30s");
	expect(formatTime(125999)).toBe("2m 6s");
});
