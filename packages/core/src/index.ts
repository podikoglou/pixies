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
	PrimitiveTraceEntry,
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
	PersistedTranscriptSchema,
	PersistedAgentMessageSchema,
	isPersistedTranscript,
} from "./persisted-transcript.ts";
export {
	countTranscriptTokens,
	budgetExceeded,
	type TranscriptTokenCount,
} from "./token-budget.ts";

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
export { isAbortError, mergeSignals } from "./utils/abort.ts";
