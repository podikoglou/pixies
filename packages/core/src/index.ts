// --- better-result primitives + TaggedError hierarchy (issue #109) ---
export { Result, TaggedError, matchError, matchErrorPartial, isTaggedError } from "better-result";
export type { SerializedResult } from "better-result";
export {
	NominatimBusyError,
	NominatimHttpError,
	NominatimParseError,
} from "./clients/nominatim.ts";
export {
	OverpassBusyError,
	OverpassHttpError,
	OverpassParseError,
	OverpassRemarkError,
} from "./clients/overpass.ts";
export {
	ToolAbortedError,
	DisplayMapValidationError,
	ConversationNotFoundError,
	PromptConflictError,
	BudgetExceededError,
	InvalidJsonError,
	ValidationError,
	ConfigError,
	InvalidTranscriptError,
} from "./errors.ts";
export type { NominatimError } from "./clients/nominatim.ts";
export type { OverpassError } from "./clients/overpass.ts";
export type { StreamPromptError, PixiesError, PixiesErrorTag } from "./errors.ts";

export { createAgent, createOsmClients, readConfigFromEnv } from "./agent.ts";
export type { CreateAgentOptions, CreateOsmClientsOptions } from "./agent.ts";
export { PixiesConfigSchema, type ResolvedPixiesConfig } from "./config-schema.ts";
export { SYSTEM_PROMPT } from "./system-prompt.ts";
export {
	ConversationCreatedData,
	MessageStartData,
	TextDeltaData,
	TextContentBlock,
	UnknownContentBlock,
	ContentBlock,
	AssistantMessageSchema,
	toClientAssistantMessage,
	MessageEndData,
	ToolExecutionStartData,
	ToolExecutionUpdateData,
	ToolResultSchema,
	ToolExecutionEndData,
	DoneData,
	ErrorData,
	SSEEventSchema,
	SSE_EVENT_DATA_SCHEMAS,
} from "./sse-events.ts";
export type {
	ContentBlockType,
	SSEEvent,
	SSEEventName,
	ClientAssistantMessage,
} from "./sse-events.ts";
export {
	createTools,
	ToolProgressSchema,
	isToolProgress,
	GeocodeResultEntrySchema,
	OverpassResultEntrySchema,
	GeocodeToolDetailsSchema,
	ReverseGeocodeToolDetailsSchema,
	QueryOsmToolDetailsSchema,
	DisplayMapDataSchema,
	DisplayMapToolDetailsSchema,
	parseToolResult,
} from "./tools/index.ts";
export type {
	GeocodeToolDetails,
	ReverseGeocodeToolDetails,
	QueryOsmToolDetails,
	DisplayMapData,
	DisplayMapToolDetails,
	ToolProgress,
	ToolResult,
	GeocodeResultEntry,
	OverpassResultEntry,
	OsmClients,
} from "./tools/index.ts";
export {
	ConversationTranscriptSchema,
	isConversationTranscript,
	PersistedTranscriptSchema,
	PersistedAgentMessageSchema,
	isPersistedTranscript,
	toClientTranscriptMessage,
} from "./transcript-schema.ts";
export type {
	ConversationTranscript,
	TranscriptContentBlock,
	TranscriptUserMessage,
	TranscriptAssistantMessage,
	TranscriptToolResultMessage,
	TranscriptMessage,
} from "./transcript-schema.ts";

export { NominatimClient, formatNominatimResult } from "./clients/nominatim.ts";
export type {
	NominatimConfig,
	NominatimResult,
	NominatimRateLimitCallbacks,
} from "./clients/nominatim.ts";
export { OverpassClient, formatElement } from "./clients/overpass.ts";
export type {
	OverpassConfig,
	OverpassElement,
	OverpassResponse,
	OverpassRateLimitCallbacks,
} from "./clients/overpass.ts";
export { OSM_SERVER_BUSY_MESSAGE } from "./tools/busy-message.ts";
export { isAbortError } from "./utils/abort.ts";
