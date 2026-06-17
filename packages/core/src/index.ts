// --- better-result primitives + TaggedError hierarchy (issue #109) ---
export { Result, TaggedError, matchError, matchErrorPartial, isTaggedError } from "better-result";
export type { SerializedResult } from "better-result";
export {
	OsmBusyError,
	OsmHttpError,
	OsmParseError,
	OsmRemarkError,
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
export type { OsmError, StreamPromptError, PixiesError, PixiesErrorTag } from "./errors.ts";

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
	summarizeToolResult,
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

export { NominatimClient } from "./osm/nominatim.ts";
export type { NominatimConfig, NominatimResult } from "./osm/nominatim.ts";
export { OverpassClient } from "./osm/overpass.ts";
export type { OverpassConfig, OverpassResponse } from "./osm/overpass.ts";
export { createRateLimiter } from "./osm/rate-limiter.ts";
export type { RateLimiterOptions, RateLimiter, RateLimitCallbacks } from "./osm/rate-limiter.ts";
export {
	OSM_SERVER_BUSY_MESSAGE,
	isServerBusyResponse,
	SERVER_BUSY_BODY_MARKERS,
	isAbortError,
} from "./osm/http.ts";
