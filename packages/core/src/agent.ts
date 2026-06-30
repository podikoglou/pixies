import { Agent, type AfterToolCallContext } from "@earendil-works/pi-agent-core";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { getModels, getProviders } from "@earendil-works/pi-ai";
import type { Api, KnownProvider, Model, TextContent } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { PixiesConfigSchema, type ResolvedPixiesConfig } from "./config-schema.ts";
import { silentLogger, type Logger } from "./logging/index.ts";
import { NominatimClient } from "./clients/nominatim.ts";
import { OverpassClient } from "./clients/overpass.ts";
import { createTools } from "./tools/index.ts";
import type { CodeExecutor } from "./tools/tool-execute-code.ts";
import { SYSTEM_PROMPT } from "./system-prompt.ts";

export type { ResolvedPixiesConfig } from "./config-schema.ts";

/**
 * Known-provider registry snapshot (see `config-schema.ts` for rationale).
 * Mirrored here so `resolveModel` stays a pure, self-contained guard without
 * reaching across into the config module.
 */
const KNOWN_PROVIDERS: ReadonlySet<string> = new Set(getProviders());

/** Type guard: narrows a free-form string to pi-ai's `KnownProvider` union. */
function isKnownProvider(value: string): value is KnownProvider {
	return KNOWN_PROVIDERS.has(value);
}

function resolveModel(modelRef: string): Model<Api> {
	const slashIndex = modelRef.indexOf("/");
	if (slashIndex === -1) {
		throw new Error(`Model must be in "provider/model-id" format. Got: "${modelRef}"`);
	}

	const provider = modelRef.slice(0, slashIndex);
	const modelId = modelRef.slice(slashIndex + 1);

	// Defense-in-depth: the config schema in config-schema.ts already rejects
	// unknown providers at boot, but `resolveModel` is exported-reachable
	// (and unit-testable) on its own, so it must not trust its input. The guard
	// also narrows `provider` to `KnownProvider`, removing the `as` cast on the
	// `getModels` call.
	if (!isKnownProvider(provider)) {
		throw new Error(
			`Unknown provider "${provider}". Valid providers: ${[...KNOWN_PROVIDERS].join(", ")}`,
		);
	}

	const models = getModels(provider) as Model<Api>[];
	const model = models.find((m) => m.id === modelId);
	if (!model) {
		throw new Error(`Unknown model: "${modelRef}". Check provider and model ID.`);
	}

	return model;
}

/**
 * Read an env var, treating undefined/empty/whitespace as "unset" (returns
 * undefined) so the schema applies its documented default. The empty-as-unset
 * rule matters most for numeric fields: without it, `PIXIES_HTTP_RATE_LIMIT=`
 * would coerce `""` to `0` and silently disable rate limiting. Shared with
 * `@pixies/server`'s `ServerConfigSchema` reader so both config surfaces agree.
 */
export function env(name: string): string | undefined {
	const v = process.env[name];
	return v && v.trim().length > 0 ? v : undefined;
}

/**
 * Read a numeric env var, returning `undefined` when unset/empty so the schema
 * applies its documented default. Coercion is an explicit `Number()` — NOT
 * `Value.Convert` (which silently truncates "3.5" → 3) — so non-integer
 * strings like "3.5" are rejected by `Type.Integer` just like Zod's
 * `z.coerce.number().int()` did.
 */
function num(name: string): number | undefined {
	const v = env(name);
	return v === undefined ? undefined : Number(v);
}

export function readConfigFromEnv(): ResolvedPixiesConfig {
	// `Value.Default` fills in documented defaults for missing/empty fields;
	// `Value.Parse` then validates (formats, integer bounds, the provider
	// Refine). Unlike Zod's `.parse()`, Value.Parse does NOT apply defaults on
	// its own, so both run in sequence. Value.Default mutates its input, which
	// is safe here — the object literal below is freshly built per call.
	return Value.Parse(
		PixiesConfigSchema,
		Value.Default(PixiesConfigSchema, {
			model: env("PIXIES_MODEL"),
			apiKey: env("PIXIES_API_KEY"),
			contactEmail: env("PIXIES_CONTACT_EMAIL"),
			overpassUrl: env("PIXIES_OVERPASS_URL"),
			nominatimUrl: env("PIXIES_NOMINATIM_URL"),
			userAgent: env("PIXIES_USER_AGENT"),
			host: env("PIXIES_HOST"),
			port: num("PIXIES_PORT"),
			thinkingLevel: env("PIXIES_THINKING_LEVEL"),
			dbFile: env("PIXIES_DB_FILE"),
			cacheSize: num("PIXIES_CACHE_SIZE"),
			httpRateLimit: num("PIXIES_HTTP_RATE_LIMIT"),
			httpRateLimitWindowMs: num("PIXIES_HTTP_RATE_LIMIT_WINDOW_MS"),
			// Boolean coercion must NOT use the env() helper or coerce-from-string —
			// both would coerce "false" → true. Keep the explicit === "true" check.
			trustProxy: process.env.PIXIES_TRUST_PROXY === "true",
			trustedProxyHops: num("PIXIES_TRUSTED_PROXY_HOPS"),
			nominatimConcurrency: num("PIXIES_NOMINATIM_CONCURRENCY"),
			nominatimIntervalCap: num("PIXIES_NOMINATIM_INTERVAL_CAP"),
			nominatimIntervalMs: num("PIXIES_NOMINATIM_INTERVAL_MS"),
			nominatimCacheTtlMs: num("PIXIES_NOMINATIM_CACHE_TTL_MS"),
			nominatimCacheMaxEntries: num("PIXIES_NOMINATIM_CACHE_MAX_ENTRIES"),
			nominatimTimeoutMs: num("PIXIES_NOMINATIM_TIMEOUT_MS"),
			overpassConcurrency: num("PIXIES_OVERPASS_CONCURRENCY"),
			overpassIntervalCap: num("PIXIES_OVERPASS_INTERVAL_CAP"),
			overpassIntervalMs: num("PIXIES_OVERPASS_INTERVAL_MS"),
			overpassTimeoutMs: num("PIXIES_OVERPASS_TIMEOUT_MS"),
			posthogHost: env("PIXIES_POSTHOG_HOST"),
			posthogApiKey: env("PIXIES_POSTHOG_API_KEY"),
			conversationTokenBudget: num("PIXIES_CONVERSATION_TOKEN_BUDGET"),
			maxPromptChars: num("PIXIES_MAX_PROMPT_CHARS"),
		}),
	);
}

export interface CreateAgentOptions {
	config: ResolvedPixiesConfig;
	fetch?: typeof globalThis.fetch;
	/** Sandboxed Python executor (Monty) for the `execute_code` tool. Required — there is no built-in fallback. */
	codeExecutor: CodeExecutor;
}

/**
 * Runtime overrides both service-client factories accept alongside resolved
 * config: an injectable `fetch` (for tests) and a `logger`. Shared across the
 * Nominatim and Overpass factories since both bridge config → client the same
 * way.
 */
interface ClientFactoryOverrides {
	fetch?: typeof globalThis.fetch;
	logger?: Logger;
}

/**
 * Resolved-config fields that configure a {@link NominatimClient}. Kept as a
 * named Pick so the factory's input surface is self-documenting and stays in
 * lockstep with the schema fields rather than a free-form partial.
 */
type NominatimConfigFields = Pick<
	ResolvedPixiesConfig,
	| "nominatimUrl"
	| "contactEmail"
	| "userAgent"
	| "nominatimConcurrency"
	| "nominatimIntervalCap"
	| "nominatimIntervalMs"
	| "nominatimCacheTtlMs"
	| "nominatimCacheMaxEntries"
	| "nominatimTimeoutMs"
>;

/**
 * Build a {@link NominatimClient} from resolved config. The single source of
 * truth for the config → client projection, used by both the server-owned
 * singleton (ADR-0004) and the {@link createAgent} fallback — so adding a
 * Nominatim knob is a one-site change with no silent drift between the two.
 */
export function createNominatimClient(
	config: NominatimConfigFields,
	opts: ClientFactoryOverrides = {},
): NominatimClient {
	return new NominatimClient({
		baseUrl: config.nominatimUrl,
		contactEmail: config.contactEmail,
		userAgent: config.userAgent,
		fetch: opts.fetch,
		concurrency: config.nominatimConcurrency,
		intervalCap: config.nominatimIntervalCap,
		intervalMs: config.nominatimIntervalMs,
		cacheTtlMs: config.nominatimCacheTtlMs,
		cacheMaxEntries: config.nominatimCacheMaxEntries,
		timeoutMs: config.nominatimTimeoutMs,
		logger: opts.logger ?? silentLogger,
	});
}

/**
 * Resolved-config fields that configure an {@link OverpassClient}; see
 * {@link NominatimConfigFields}.
 */
type OverpassConfigFields = Pick<
	ResolvedPixiesConfig,
	| "overpassUrl"
	| "userAgent"
	| "overpassConcurrency"
	| "overpassIntervalCap"
	| "overpassIntervalMs"
	| "overpassTimeoutMs"
>;

/**
 * Build an {@link OverpassClient} from resolved config; see
 * {@link createNominatimClient} for why the projection lives in one factory.
 */
export function createOverpassClient(
	config: OverpassConfigFields,
	opts: ClientFactoryOverrides = {},
): OverpassClient {
	return new OverpassClient({
		baseUrl: config.overpassUrl,
		userAgent: config.userAgent,
		fetch: opts.fetch,
		concurrency: config.overpassConcurrency,
		intervalCap: config.overpassIntervalCap,
		intervalMs: config.overpassIntervalMs,
		timeoutMs: config.overpassTimeoutMs,
		logger: opts.logger ?? silentLogger,
	});
}

/** Python error types produced by incorrect LLM-written code. */
const CODING_ERROR_PATTERN = /^(Type|Syntax|Name|Key|Value|ModuleNotFound|Import)Error\b/m;

/** RuntimeError sub-patterns that indicate the LLM wrote a bad query, not a service outage. */
const QUERY_ERROR_PATTERN =
	/\b(Invalid Overpass query|bounding box area.*exceeds safe limit|area must specify one of)\b/;

/** Shape-misuse sub-patterns: passing a FeaturesEnvelope where a bare list is
 *  expected (the most common list/envelope confusion). The thrown error names
 *  the wrong type and the fix; this makes it immediately retryable.
 *
 *  NOTE: no trailing `\b` — `]` is a non-word char, so `\b` after it would only
 *  match if a word char followed `[Feature]`, which never happens in the real
 *  throw (`${name} must be a list[Feature], got ${got}` at host-call-shapes.ts).
 *  The leading `\b` is sufficient and matches the documented contract in
 *  system-prompt.ts ("shape error → fix and retry"). */
const SHAPE_ERROR_PATTERN = /\bmust be a list\[Feature\]/;

function isRetryableError(text: string): boolean {
	return (
		CODING_ERROR_PATTERN.test(text) ||
		QUERY_ERROR_PATTERN.test(text) ||
		SHAPE_ERROR_PATTERN.test(text)
	);
}

/**
 * Prepend a retry directive so the LLM never gives up on its own mistakes.
 * Includes RuntimeError sub-patterns for query-construction errors (e.g.
 * bounding-box too large) that the LLM can fix by narrowing its search.
 */
function prependRetryDirective(errorText: string): TextContent[] {
	const match = errorText.match(/^(\w+):/);
	const errorType = match?.[1] ?? "error";
	return [
		{
			type: "text",
			text: `Your code produced a ${errorType}. Fix the issue and call execute_code again.\n\n${errorText}`,
		},
	];
}

/**
 * Transient network/timeout failures. Both OSM clients wrap any uncaught throw
 * that is not a caller-abort as `network error: <reason>` (overpass.ts /
 * nominatim.ts), so this prefix is the stable, server-authored signal that the
 * request never completed — distinct from the non-retryable busy message
 * (OVERPASS_BUSY_MESSAGE / NOMINATIM_BUSY_MESSAGE), which this does not match.
 */
const TRANSIENT_NETWORK_PATTERN = /\bnetwork error\b/i;

/** The kind of tool error, deciding which retry directive (if any) to inject. */
export type ToolErrorKind = "coding" | "transient" | "other";

/**
 * Classify a tool-error text into the retry strategy that applies. Pure and
 * unit-testable. "other" covers the non-retryable busy/overload signal and
 * anything unrecognized — the caller must not inject a retry directive for it.
 */
export function classifyToolError(text: string): ToolErrorKind {
	if (TRANSIENT_NETWORK_PATTERN.test(text)) return "transient";
	if (isRetryableError(text)) return "coding";
	return "other";
}

/**
 * Build the retry directive to inject in place of the raw error, or null when
 * the kind is non-retryable. Pure and unit-testable.
 */
export function retryDirectiveFor(kind: ToolErrorKind, errorText: string): TextContent[] | null {
	if (kind === "coding") return prependRetryDirective(errorText);
	if (kind === "transient") {
		return [
			{
				type: "text",
				text: `The previous call failed with a transient network error — the OSM endpoint timed out or dropped the connection mid-request. This is temporary and not a problem with your query or arguments. Retry the SAME call, unchanged, in a new execute_code block.\n\n${errorText}`,
			},
		];
	}
	return null;
}

/** Max consecutive transient-error retries per conversation before giving up gracefully. */
export const MAX_TRANSIENT_RETRIES = 2;

/**
 * Directive injected when the transient retry budget is exhausted: the backing
 * service appears to be down. Phrased to match the busy-message convention
 * ("tell the user … temporarily unavailable") — the agent is prose-less by
 * design, so this directive carries the user-facing wording.
 */
const TRANSIENT_GIVE_UP_TEXT =
	"The backing service has failed with a transient network error several times in a row and appears to be down. Stop retrying. Tell the user that the map service is temporarily unavailable and suggest they try again shortly.";

export function createAgent(options: CreateAgentOptions): Agent {
	const { config } = options;
	const model = resolveModel(config.model);
	const tools = createTools({ executor: options.codeExecutor });
	const agent = new Agent({
		initialState: {
			systemPrompt: SYSTEM_PROMPT,
			model,
			thinkingLevel: config.thinkingLevel,
			tools,
		},
		getApiKey: () => config.apiKey,
	});

	let lastToolWasError = false;
	let lastErrorKind: ToolErrorKind = "other";
	let transientRetryCount = 0;

	agent.afterToolCall = async (ctx: AfterToolCallContext) => {
		if (!ctx.isError) {
			lastToolWasError = false;
			lastErrorKind = "other";
			transientRetryCount = 0;
			return;
		}
		lastToolWasError = true;
		const textContent = ctx.result.content.map((c) => ("text" in c ? c.text : "")).join("\n");
		lastErrorKind = classifyToolError(textContent);
		if (lastErrorKind === "transient" && transientRetryCount >= MAX_TRANSIENT_RETRIES) {
			return { content: [{ type: "text", text: TRANSIENT_GIVE_UP_TEXT }] };
		}
		const directive = retryDirectiveFor(lastErrorKind, textContent);
		if (directive) {
			if (lastErrorKind === "transient") transientRetryCount++;
			return { content: directive };
		}
	};

	agent.subscribe((event: AgentEvent) => {
		if (event.type === "turn_end" && lastToolWasError) {
			const msg = event.message;
			const content = msg.role === "assistant" ? msg.content : undefined;
			const toolCalls = content?.filter((c: { type: string }) => c.type === "toolCall");
			if (!toolCalls || toolCalls.length === 0) {
				const steerText =
					lastErrorKind === "transient"
						? transientRetryCount >= MAX_TRANSIENT_RETRIES
							? "The map service appears to be down after repeated network errors. Stop retrying and end the turn."
							: "The previous call hit a transient network error, not a bad query. Retry the SAME call unchanged in a new execute_code block."
						: "You got an error. Retry with a different approach — narrow the area, fix arguments, or simplify the query.";
				agent.steer({
					role: "user",
					content: [{ type: "text", text: steerText }],
					timestamp: Date.now(),
				});
			}
		}
	});

	return agent;
}
