export { createAgent, createOsmClients, readConfigFromEnv } from "./agent.ts";
export type { CreateAgentOptions, CreateOsmClientsOptions } from "./agent.ts";
export {
	PixiesConfigSchema,
	type PixiesConfig,
	type ResolvedPixiesConfig,
} from "./config-schema.ts";
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
	createToolRegistry,
	createTools,
	toolLabel,
	summarizeToolDetails,
	ToolProgressSchema,
	isToolProgress,
	ToolNameSchema,
	isToolName,
	GeocodeResultEntrySchema,
	OverpassResultEntrySchema,
	GeocodeToolDetailsSchema,
	ReverseGeocodeToolDetailsSchema,
	QueryOsmToolDetailsSchema,
	DisplayMapDataSchema,
	isDisplayMapData,
	DisplayMapToolDetailsSchema,
	ToolDetailsDiscriminatedUnionSchema,
	parseToolResult,
	summarizeResult,
} from "./tools/index.ts";
export type {
	GeocodeToolDetails,
	ReverseGeocodeToolDetails,
	QueryOsmToolDetails,
	DisplayMapData,
	DisplayMapToolDetails,
	ToolName,
	ToolProgress,
	ToolRegistry,
	ToolDetailsMap,
	ToolDetails,
	ToolDetailVariant,
	ToolDetailsDiscriminatedUnion,
	ToolResult,
	ToolResultData,
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
export {
	OsmServerBusyError,
	OSM_SERVER_BUSY_MESSAGE,
	isServerBusyResponse,
	SERVER_BUSY_BODY_MARKERS,
} from "./osm/http.ts";
