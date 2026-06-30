import { test, expect, describe } from "bun:test";
import { summarize } from "./pixies_provider.mjs";

// `summarize(message, events, fatal)` — fatal is the `error` event's data, or null.
// Each case builds the smallest event list that exercises one status branch.

describe("summarize status taxonomy", () => {
	const CC = { event: "conversation_created", data: { id: "abc" } };

	test("answered: done + a tool call that produced a display", () => {
		// one tool_execution_end carrying a feature in result.details.displays
		const events = [
			CC,
			{
				event: "tool_execution_start",
				data: { toolCallId: "t1", toolName: "execute_code", args: { code: "x" } },
			},
			{
				event: "tool_execution_end",
				data: {
					toolCallId: "t1",
					isError: false,
					result: {
						details: { displays: [{ features: [{ name: "IKEA Athens", lat: 38, lon: 23.7 }] }] },
					},
				},
			},
			{ event: "done", data: { durationMs: 5900 } },
		];
		expect(summarize("q", events, null).status).toBe("answered");
	});

	test("REGRESSION: stream cut right after conversation_created → empty_stream (NOT no_tool_call)", () => {
		// the exact shape of the 6 reported failures: created, then the stream closes, no done/error
		expect(summarize("q", [CC], null).status).toBe("empty_stream");
	});

	test("empty_stream even with tool calls if there was no done (interrupted mid-flight)", () => {
		const events = [
			CC,
			{
				event: "tool_execution_start",
				data: { toolCallId: "t1", toolName: "execute_code", args: {} },
			},
			// no tool_execution_end, no done — agent was working when the stream died
		];
		const s = summarize("q", events, null);
		expect(s.status).toBe("empty_stream"); // NOT gave_up — it never finished
	});

	test("no_tool_call: done present, but zero tool calls (genuine agent no-op)", () => {
		expect(summarize("q", [CC, { event: "done", data: { durationMs: 1200 } }], null).status).toBe(
			"no_tool_call",
		);
	});

	test("gave_up: done + tool calls + zero displays (the regression this suite exists for)", () => {
		const events = [
			CC,
			{
				event: "tool_execution_start",
				data: { toolCallId: "t1", toolName: "execute_code", args: {} },
			},
			{
				event: "tool_execution_end",
				data: { toolCallId: "t1", isError: false, result: { details: { displays: [] } } },
			},
			{ event: "done", data: { durationMs: 8000 } },
		];
		expect(summarize("q", events, null).status).toBe("gave_up");
	});

	test("service_busy: fatal errorTag OverpassBusy", () => {
		expect(summarize("q", [CC], { errorTag: "OverpassBusy", message: "busy" }).status).toBe(
			"service_busy",
		);
	});

	test("budget_exceeded: fatal errorTag BudgetExceeded", () => {
		expect(
			summarize("q", [CC], { errorTag: "BudgetExceeded", message: "over budget" }).status,
		).toBe("budget_exceeded");
	});

	test("error: any other fatal event", () => {
		expect(summarize("q", [CC], { message: "kaboom" }).status).toBe("error");
	});

	test("sawDone is reflected even when durationMs is absent (done frame with no payload)", () => {
		// done is the terminal signal; durationMs is optional on the wire (DoneData).
		expect(summarize("q", [CC, { event: "done", data: {} }], null).status).toBe("no_tool_call");
	});
});
