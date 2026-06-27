import { Agent } from "@earendil-works/pi-agent-core";
import { getModels, getProviders } from "@earendil-works/pi-ai";
import type { Api, KnownProvider, Model } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { PixiesConfigSchema, type ResolvedPixiesConfig } from "./config-schema.ts";
import { silentLogger, type Logger } from "./logging/index.ts";
import { NominatimClient } from "./clients/nominatim.ts";
import { OverpassClient } from "./clients/overpass.ts";
import { createTools } from "./tools/index.ts";
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
 * undefined). This lets the schema apply documented defaults instead of
 * coercing `""` to `0`/`NaN`, which is critical for fields like
 * `httpRateLimit` where `PIXIES_HTTP_RATE_LIMIT=` must NOT silently disable
 * rate limiting.
 */
function env(name: string): string | undefined {
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
		}),
	);
}

export interface CreateAgentOptions {
	config: ResolvedPixiesConfig;
	fetch?: typeof globalThis.fetch;
	/**
	 * Pre-built Nominatim client. When omitted, the client is constructed
	 * inside this call via {@link createNominatimClient} (the path used by
	 * single-user adapters and tests). Multi-tenant adapters (e.g. the server)
	 * MUST inject a single shared instance so the Nominatim rate-limit chain is
	 * process-global — see ADR-0004.
	 */
	nominatim?: NominatimClient;
	/**
	 * Pre-built Overpass client; see {@link CreateAgentOptions.nominatim} for
	 * the injection / fallback contract.
	 */
	overpass?: OverpassClient;
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

export function createAgent(options: CreateAgentOptions): Agent {
	const { config } = options;
	const model = resolveModel(config.model);
	// Inject callers own the client lifetime (server: one per process). When
	// not injected, build a fresh pair — this preserves the single-user/test
	// path. See ADR-0004.
	const nominatim = options.nominatim ?? createNominatimClient(config, { fetch: options.fetch });
	const overpass = options.overpass ?? createOverpassClient(config, { fetch: options.fetch });
	const tools = createTools(nominatim, overpass);
	return new Agent({
		initialState: {
			systemPrompt: SYSTEM_PROMPT,
			model,
			thinkingLevel: config.thinkingLevel,
			tools,
		},
		getApiKey: () => config.apiKey,
	});
}
