import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

export const TranscriptContentBlockSchema = Type.Object({
	type: Type.String(),
	text: Type.Optional(Type.String()),
});

export type TranscriptContentBlock = Static<typeof TranscriptContentBlockSchema>;

export const TranscriptUserMessageSchema = Type.Object({
	role: Type.Literal("user"),
	content: Type.Union([Type.String(), Type.Array(TranscriptContentBlockSchema)]),
});

export type TranscriptUserMessage = Static<typeof TranscriptUserMessageSchema>;

export const TranscriptAssistantMessageSchema = Type.Object({
	role: Type.Literal("assistant"),
	content: Type.Array(TranscriptContentBlockSchema),
	stopReason: Type.Optional(Type.String()),
});

export type TranscriptAssistantMessage = Static<typeof TranscriptAssistantMessageSchema>;

export const TranscriptToolResultMessageSchema = Type.Object({
	role: Type.Literal("toolResult"),
	toolCallId: Type.String(),
	toolName: Type.String(),
	content: Type.Array(TranscriptContentBlockSchema),
	details: Type.Optional(Type.Unknown()),
	isError: Type.Boolean(),
});

export type TranscriptToolResultMessage = Static<typeof TranscriptToolResultMessageSchema>;

export const TranscriptMessageSchema = Type.Union([
	TranscriptUserMessageSchema,
	TranscriptAssistantMessageSchema,
	TranscriptToolResultMessageSchema,
]);

export type TranscriptMessage = Static<typeof TranscriptMessageSchema>;

export const ConversationTranscriptSchema = Type.Object({
	id: Type.String(),
	messages: Type.Array(TranscriptMessageSchema),
});

export type ConversationTranscript = Static<typeof ConversationTranscriptSchema>;

export function isConversationTranscript(value: unknown): value is ConversationTranscript {
	return Value.Check(ConversationTranscriptSchema, value);
}
