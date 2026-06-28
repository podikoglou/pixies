// --- better-result primitives + TaggedError hierarchy ---
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
	CodeExecutionError,
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
export { PixiesErrorTagSchema, BudgetExceededDetailsSchema } from "./errors.ts";

export {
	createAgent,
	createNominatimClient,
	createOverpassClient,
	readConfigFromEnv,
	env,
} from "./agent.ts";
export type { CreateAgentOptions } from "./agent.ts";
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
	parseToolResult,
	isBusyResult,
	toolResultCount,
} from "./tools/index.ts";
export type {
	CodeExecutor,
	CodeExecutionSuccess,
	ExecuteCodeDetails,
	ToolProgress,
	ToolResult,
	HostContext,
	Feature,
	GeocodeResult,
	FindFeaturesResult,
	SpatialPair,
	DisplayData,
} from "./tools/index.ts";
export {
	ConversationTranscriptSchema,
	isConversationTranscript,
	PersistedTranscriptSchema,
	PersistedAgentMessageSchema,
	isPersistedTranscript,
	toClientTranscriptMessage,
} from "./transcript-schema.ts";
export {
	countTranscriptTokens,
	budgetExceeded,
	type TranscriptTokenCount,
} from "./token-budget.ts";
export type {
	ConversationTranscript,
	TranscriptContentBlock,
	TranscriptUserMessage,
	TranscriptAssistantMessage,
	TranscriptToolResultMessage,
	TranscriptMessage,
} from "./transcript-schema.ts";

export {
	NominatimClient,
	formatNominatimResult,
	NominatimConfigSchema,
} from "./clients/nominatim.ts";
export type {
	NominatimConfig,
	NominatimResult,
	NominatimRateLimitCallbacks,
} from "./clients/nominatim.ts";
export { OverpassClient, formatElement, OverpassConfigSchema } from "./clients/overpass.ts";
export type {
	OverpassConfig,
	OverpassElement,
	OverpassResponse,
	OverpassRateLimitCallbacks,
} from "./clients/overpass.ts";
export { NOMINATIM_BUSY_MESSAGE } from "./clients/nominatim.ts";
export { OVERPASS_BUSY_MESSAGE } from "./clients/overpass.ts";
export { isAbortError } from "./utils/abort.ts";
