/// <reference types="bun" />
import { expect, test } from "bun:test";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { translateAgentEvent } from "./events.ts";

test("tool_execution_start forwards with toolCallId, toolName, and args", () => {
	const event: AgentEvent = {
		type: "tool_execution_start",
		toolCallId: "call_1",
		toolName: "geocode",
		args: { q: "Berlin" },
	} as AgentEvent;

	const out = translateAgentEvent(event);
	expect(out).toEqual([
		{
			event: "tool_execution_start",
			data: { toolCallId: "call_1", toolName: "geocode", args: { q: "Berlin" } },
		},
	]);
});

test("tool_execution_end forwards with result", () => {
	const event: AgentEvent = {
		type: "tool_execution_end",
		toolCallId: "call_1",
		isError: false,
		result: { content: [{ type: "text", text: "ok" }] },
	} as AgentEvent;

	const out = translateAgentEvent(event);
	expect(out).toEqual([
		{
			event: "tool_execution_end",
			data: {
				toolCallId: "call_1",
				isError: false,
				result: { content: [{ type: "text", text: "ok" }] },
			},
		},
	]);
});

test("tool_execution_update returns empty (progress concept removed)", () => {
	const event: AgentEvent = {
		type: "tool_execution_update",
		toolCallId: "call_1",
		toolName: "geocode",
		args: { q: "Berlin" },
		partialResult: { details: { type: "running" } },
	} as AgentEvent;

	expect(translateAgentEvent(event)).toEqual([]);
});
