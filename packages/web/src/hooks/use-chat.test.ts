/// <reference types="bun" />
import { test, expect } from "bun:test";
import type { Dispatch } from "react";
import type { SSEEvent } from "@pixies/core";
import { dispatchSseEvent } from "./use-chat.ts";
import type { ChatAction } from "../state/chat-reducer.ts";

function capture(): { dispatch: Dispatch<ChatAction>; actions: ChatAction[] } {
	const actions: ChatAction[] = [];
	const dispatch = ((action: ChatAction) => {
		actions.push(action);
	}) as Dispatch<ChatAction>;
	return { dispatch, actions };
}

test("conversation_created fires callback once with id and still dispatches CONVERSATION_CREATED", () => {
	const { dispatch, actions } = capture();
	const calls: string[] = [];
	const cb = (id: string) => {
		calls.push(id);
	};
	const evt: SSEEvent = { event: "conversation_created", data: { id: "abc-123" } };

	dispatchSseEvent(evt, dispatch, cb);

	expect(calls).toEqual(["abc-123"]);
	expect(actions).toEqual([{ type: "CONVERSATION_CREATED", id: "abc-123" }]);
});

test("conversation_created does not throw when no callback is supplied", () => {
	const { dispatch, actions } = capture();
	const evt: SSEEvent = { event: "conversation_created", data: { id: "abc-123" } };

	dispatchSseEvent(evt, dispatch);

	expect(actions).toEqual([{ type: "CONVERSATION_CREATED", id: "abc-123" }]);
});

test("tool_execution_start does not fire callback and dispatches TOOL_START", () => {
	const { dispatch, actions } = capture();
	const evt: SSEEvent = {
		event: "tool_execution_start",
		data: { toolCallId: "tc-1", toolName: "query_osm", args: { q: "*" } },
	};

	dispatchSseEvent(evt, dispatch, () => {
		throw new Error("should not fire");
	});

	expect(actions).toEqual([
		{ type: "TOOL_START", toolCallId: "tc-1", toolName: "query_osm", args: { q: "*" } },
	]);
});

test("tool_execution_update with progress does not fire callback and dispatches TOOL_UPDATE", () => {
	const { dispatch, actions } = capture();
	const evt: SSEEvent = {
		event: "tool_execution_update",
		data: { toolCallId: "tc-1", details: { type: "running" } },
	};

	dispatchSseEvent(evt, dispatch, () => {
		throw new Error("should not fire");
	});

	expect(actions).toEqual([
		{ type: "TOOL_UPDATE", toolCallId: "tc-1", progress: { type: "running" } },
	]);
});

test("tool_execution_end does not fire callback and dispatches TOOL_END", () => {
	const { dispatch, actions } = capture();
	const evt: SSEEvent = {
		event: "tool_execution_end",
		data: {
			toolCallId: "tc-1",
			isError: false,
			result: { content: [{ type: "text", text: "ok" }] },
		},
	};

	dispatchSseEvent(evt, dispatch, () => {
		throw new Error("should not fire");
	});

	expect(actions).toEqual([
		{
			type: "TOOL_END",
			toolCallId: "tc-1",
			isError: false,
			resultText: "ok",
			details: undefined,
		},
	]);
});

test("done does not fire callback and dispatches STREAM_DONE", () => {
	const { dispatch, actions } = capture();
	const evt: SSEEvent = { event: "done", data: {} };

	dispatchSseEvent(evt, dispatch, () => {
		throw new Error("should not fire");
	});

	expect(actions).toEqual([{ type: "STREAM_DONE" }]);
});

test("error does not fire callback and dispatches SET_ERROR", () => {
	const { dispatch, actions } = capture();
	const evt: SSEEvent = { event: "error", data: { message: "boom" } };

	dispatchSseEvent(evt, dispatch, () => {
		throw new Error("should not fire");
	});

	expect(actions).toEqual([{ type: "SET_ERROR", message: "boom" }]);
});
