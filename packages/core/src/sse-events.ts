import { Type } from "typebox";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import type { AssistantMessage as PiAiAssistantMessage } from "@earendil-works/pi-ai";

export const ConversationCreatedData = Type.Object({
	id: Type.String(),
});

export const MessageStartData = Type.Object({});

export const TextDeltaData = Type.Object({
	delta: Type.String(),
});

export const TextContentBlock = Type.Object(
	{
		type: Type.Literal("text"),
		text: Type.String(),
	},
	{ additionalProperties: false },
);

export const UnknownContentBlock = Type.Object(
	{ type: Type.String() },
	{ additionalProperties: false },
);

export const ContentBlock = Type.Union([TextContentBlock, UnknownContentBlock]);
export type ContentBlockType = Static<typeof ContentBlock>;

export const AssistantMessageSchema = Type.Object(
	{
		role: Type.Literal("assistant"),
		content: Type.Array(ContentBlock),
		stopReason: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

export type ClientAssistantMessage = Static<typeof AssistantMessageSchema>;

/**
 * Strip internal call metadata (api/provider/model/responseModel/responseId/
 * usage/diagnostics/errorMessage/timestamp) from a pi-ai AssistantMessage before
 * sending it to clients over SSE.
 *
 * Schema-driven via {@link AssistantMessageSchema} so it stays in sync with the
 * wire contract. `Value.Clean` mutates its input, so we clone first
 * — the incoming object is the agent's own internal reference (also persisted to
 * SQLite) and must not be corrupted.
 */
export function toClientAssistantMessage(msg: PiAiAssistantMessage): ClientAssistantMessage {
	return Value.Clean(AssistantMessageSchema, Value.Clone(msg)) as ClientAssistantMessage;
}

export const MessageEndData = Type.Object({
	message: AssistantMessageSchema,
});

export const ToolExecutionStartData = Type.Object({
	toolCallId: Type.String(),
	toolName: Type.String(),
	args: Type.Unknown(),
});

/**
 * Shape of a tool result on the wire. `content` is the model-facing text (the
 * pipe-delimited serialization produced by `format.ts`). `details` is the
 * structured, tool-specific payload; for the OSM tools it now carries a `data`
 * subfield with the lossless structured result (see `ToolResultData` in
 * `tools/index.ts`) that adapters render directly instead of reverse-parsing
 * the pipe string. `details` remains `Unknown` here so the schema
 * stays a permissive wire contract; per-tool shapes live with the tools.
 */
export const ToolResultSchema = Type.Object({
	content: Type.Array(ContentBlock),
	details: Type.Optional(Type.Unknown()),
});

export const ToolExecutionEndData = Type.Object({
	toolCallId: Type.String(),
	isError: Type.Boolean(),
	result: ToolResultSchema,
});

export const DoneData = Type.Object({
	durationMs: Type.Optional(Type.Number()),
});

/**
 * `"error"` event payload.
 *
 * `message` is always present (the wire contract since launch). `errorTag` and
 * `details` are **additive**: when the server catches a
 * `TaggedError` it forwards its `_tag` (e.g. `"OverpassBusy"`, `"BudgetExceeded"`)
 * and a `toJSON()` snapshot of its props so clients can render tag-specific
 * copy. Old clients ignore the unknown fields; new clients fall back to
 * `message` when `errorTag` is absent. The schema does NOT set
 * `additionalProperties: false`, matching the permissive style already used by
 * `ToolResultSchema.details`.
 */
export const ErrorData = Type.Object({
	message: Type.String(),
	errorTag: Type.Optional(Type.String()),
	details: Type.Optional(Type.Unknown()),
});

export const SSEEventSchema = Type.Union([
	Type.Object({ event: Type.Literal("conversation_created"), data: ConversationCreatedData }),
	Type.Object({ event: Type.Literal("message_start"), data: MessageStartData }),
	Type.Object({ event: Type.Literal("text_delta"), data: TextDeltaData }),
	Type.Object({ event: Type.Literal("message_end"), data: MessageEndData }),
	Type.Object({ event: Type.Literal("tool_execution_start"), data: ToolExecutionStartData }),
	Type.Object({ event: Type.Literal("tool_execution_end"), data: ToolExecutionEndData }),
	Type.Object({ event: Type.Literal("done"), data: DoneData }),
	Type.Object({ event: Type.Literal("error"), data: ErrorData }),
]);

export type SSEEventName =
	| "conversation_created"
	| "message_start"
	| "text_delta"
	| "message_end"
	| "tool_execution_start"
	| "tool_execution_end"
	| "done"
	| "error";

export type SSEEvent =
	| { event: "conversation_created"; data: Static<typeof ConversationCreatedData> }
	| { event: "message_start"; data: Static<typeof MessageStartData> }
	| { event: "text_delta"; data: Static<typeof TextDeltaData> }
	| { event: "message_end"; data: Static<typeof MessageEndData> }
	| { event: "tool_execution_start"; data: Static<typeof ToolExecutionStartData> }
	| { event: "tool_execution_end"; data: Static<typeof ToolExecutionEndData> }
	| { event: "done"; data: Static<typeof DoneData> }
	| { event: "error"; data: Static<typeof ErrorData> };

export const SSE_EVENT_DATA_SCHEMAS: Record<SSEEventName, TSchema> = {
	conversation_created: ConversationCreatedData,
	message_start: MessageStartData,
	text_delta: TextDeltaData,
	message_end: MessageEndData,
	tool_execution_start: ToolExecutionStartData,
	tool_execution_end: ToolExecutionEndData,
	done: DoneData,
	error: ErrorData,
};
