import { Agent } from "@earendil-works/pi-agent-core";
import { getModels } from "@earendil-works/pi-ai";
import type { Api, KnownProvider, Model } from "@earendil-works/pi-ai";
import { PixiesConfigSchema, type ResolvedPixiesConfig } from "./config-schema.ts";
import { silentLogger, type Logger } from "./logging/index.ts";
import { NominatimClient } from "./osm/nominatim.ts";
import { OverpassClient } from "./osm/overpass.ts";
import { createTools, type OsmClients } from "./tools/index.ts";
import { SYSTEM_PROMPT } from "./system-prompt.ts";

export type { ResolvedPixiesConfig } from "./config-schema.ts";

function resolveModel(modelRef: string): Model<Api> {
	const slashIndex = modelRef.indexOf("/");
	if (slashIndex === -1) {
		throw new Error(`Model must be in "provider/model-id" format. Got: "${modelRef}"`);
	}

	const provider = modelRef.slice(0, slashIndex);
	const modelId = modelRef.slice(slashIndex + 1);

	const models = getModels(provider as KnownProvider) as Model<Api>[];
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
 * rate limiting. See config cleanup (#101/#103/#105).
 */
function env(name: string): string | undefined {
	const v = process.env[name];
	return v && v.trim().length > 0 ? v : undefined;
}

export function readConfigFromEnv(): ResolvedPixiesConfig {
	return PixiesConfigSchema.parse({
		model: env("PIXIES_MODEL"),
		apiKey: env("PIXIES_API_KEY"),
		contactEmail: env("PIXIES_CONTACT_EMAIL"),
		overpassUrl: env("PIXIES_OVERPASS_URL"),
		nominatimUrl: env("PIXIES_NOMINATIM_URL"),
		userAgent: env("PIXIES_USER_AGENT"),
		host: env("PIXIES_HOST"),
		port: env("PIXIES_PORT"),
		thinkingLevel: env("PIXIES_THINKING_LEVEL"),
		dbFile: env("PIXIES_DB_FILE"),
		cacheSize: env("PIXIES_CACHE_SIZE"),
		httpRateLimit: env("PIXIES_HTTP_RATE_LIMIT"),
		httpRateLimitWindowMs: env("PIXIES_HTTP_RATE_LIMIT_WINDOW_MS"),
		// Boolean coercion must NOT use the env() helper or z.coerce.boolean() —
		// both would coerce "false" → true. Keep the explicit === "true" check.
		trustProxy: process.env.PIXIES_TRUST_PROXY === "true",
		nominatimConcurrency: env("PIXIES_NOMINATIM_CONCURRENCY"),
		nominatimIntervalCap: env("PIXIES_NOMINATIM_INTERVAL_CAP"),
		nominatimIntervalMs: env("PIXIES_NOMINATIM_INTERVAL_MS"),
		overpassConcurrency: env("PIXIES_OVERPASS_CONCURRENCY"),
		overpassIntervalCap: env("PIXIES_OVERPASS_INTERVAL_CAP"),
		overpassIntervalMs: env("PIXIES_OVERPASS_INTERVAL_MS"),
		discordWebhookUrl: env("PIXIES_DISCORD_WEBHOOK_URL"),
	});
}

export interface CreateAgentOptions {
	config: ResolvedPixiesConfig;
	fetch?: typeof globalThis.fetch;
	/**
	 * Pre-built OSM clients. When omitted, clients are constructed inside this
	 * call via {@link createOsmClients} (the path used by single-user adapters
	 * such as the TUI). Multi-tenant adapters (e.g. the server) MUST inject a
	 * single shared instance so the Nominatim rate-limit chain is process-global
	 * — see ADR-0004.
	 */
	osmClients?: OsmClients;
}

export interface CreateOsmClientsOptions
	extends
		Pick<ResolvedPixiesConfig, "overpassUrl" | "nominatimUrl" | "contactEmail" | "userAgent">,
		Partial<
			Pick<
				ResolvedPixiesConfig,
				| "nominatimConcurrency"
				| "nominatimIntervalCap"
				| "nominatimIntervalMs"
				| "overpassConcurrency"
				| "overpassIntervalCap"
				| "overpassIntervalMs"
			>
		> {
	fetch?: typeof globalThis.fetch;
	logger?: Logger;
}

export function createOsmClients(options: CreateOsmClientsOptions): OsmClients {
	const logger = options.logger ?? silentLogger;
	return {
		nominatim: new NominatimClient({
			baseUrl: options.nominatimUrl,
			contactEmail: options.contactEmail,
			userAgent: options.userAgent,
			fetch: options.fetch,
			concurrency: options.nominatimConcurrency,
			intervalCap: options.nominatimIntervalCap,
			intervalMs: options.nominatimIntervalMs,
			logger,
		}),
		overpass: new OverpassClient({
			baseUrl: options.overpassUrl,
			userAgent: options.userAgent,
			fetch: options.fetch,
			concurrency: options.overpassConcurrency,
			intervalCap: options.overpassIntervalCap,
			intervalMs: options.overpassIntervalMs,
			logger,
		}),
	};
}

export function createAgent(options: CreateAgentOptions): Agent {
	const { config } = options;
	const model = resolveModel(config.model);
	// Inject callers own the client lifetime (server: one per process). When not
	// injected, build a fresh pair — this preserves the TUI/test path. See ADR-0004.
	const clients =
		options.osmClients ??
		createOsmClients({
			overpassUrl: config.overpassUrl,
			nominatimUrl: config.nominatimUrl,
			contactEmail: config.contactEmail,
			userAgent: config.userAgent,
			fetch: options.fetch,
			nominatimConcurrency: config.nominatimConcurrency,
			nominatimIntervalCap: config.nominatimIntervalCap,
			nominatimIntervalMs: config.nominatimIntervalMs,
			overpassConcurrency: config.overpassConcurrency,
			overpassIntervalCap: config.overpassIntervalCap,
			overpassIntervalMs: config.overpassIntervalMs,
		});
	const tools = createTools(clients);
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
