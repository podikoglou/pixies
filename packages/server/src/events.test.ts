/// <reference types="bun" />
import { expect, test } from "bun:test";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { translateAgentEvent } from "./events.ts";

/**
 * Regression guard for #47 / #79: `tool_execution_update` must only forward
 * payloads whose `details` validate as `ToolProgress` (`{type:"queued"}` |
 * `{type:"running"}`). Anything else — undefined, empty, or an unrelated
 * shape — is dropped at the agent→SSE boundary so internal tool shapes
 * never leak onto the wire (#47).
 *
 * The other branches of `translateAgentEvent` are either trivial `return []`
 * (message events and the default arm) or straight field pass-through
 * (tool_execution_start and tool_execution_end), so they are not asserted here.
 */

function updateEvent(partialResult: unknown): AgentEvent {
	return {
		type: "tool_execution_update",
		toolCallId: "call_1",
		toolName: "geocode",
		args: { q: "Berlin" },
		partialResult,
	} as AgentEvent;
}

test("tool_execution_update forwards a validated `{type:queued}` progress", () => {
	const out = translateAgentEvent(updateEvent({ details: { type: "queued" } }));
	expect(out).toEqual([
		{ event: "tool_execution_update", data: { toolCallId: "call_1", details: { type: "queued" } } },
	]);
});

test("tool_execution_update forwards a validated `{type:running}` progress", () => {
	const out = translateAgentEvent(updateEvent({ details: { type: "running" } }));
	expect(out).toEqual([
		{
			event: "tool_execution_update",
			data: { toolCallId: "call_1", details: { type: "running" } },
		},
	]);
});

test("tool_execution_update drops updates when `details` is missing (#47 guard)", () => {
	expect(translateAgentEvent(updateEvent(undefined))).toEqual([]);
	expect(translateAgentEvent(updateEvent({}))).toEqual([]);
});

test("tool_execution_update drops updates with malformed `details` (#47 guard)", () => {
	expect(translateAgentEvent(updateEvent({ details: undefined }))).toEqual([]);
	expect(translateAgentEvent(updateEvent({ details: {} }))).toEqual([]);
	expect(translateAgentEvent(updateEvent({ details: { type: "bogus" } }))).toEqual([]);
	expect(translateAgentEvent(updateEvent({ details: { foo: 1 } }))).toEqual([]);
});
