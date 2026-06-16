import { Agent } from "@earendil-works/pi-agent-core";
import { getModels } from "@earendil-works/pi-ai";
import type { Api, KnownProvider, Model } from "@earendil-works/pi-ai";
import { PixiesConfigSchema, type ResolvedPixiesConfig } from "./config-schema.ts";
import { NominatimClient } from "./osm/nominatim.ts";
import { OverpassClient } from "./osm/overpass.ts";
import { createTools, type OsmClients } from "./tools/index.ts";
import { SYSTEM_PROMPT } from "./system-prompt.ts";

export type { PixiesConfig, ResolvedPixiesConfig } from "./config-schema.ts";

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

export function readConfigFromEnv(): ResolvedPixiesConfig {
	const raw = {
		model: process.env.PIXIES_MODEL,
		apiKey: process.env.PIXIES_API_KEY,
		contactEmail: process.env.PIXIES_CONTACT_EMAIL,
		overpassUrl: process.env.PIXIES_OVERPASS_URL,
		nominatimUrl: process.env.PIXIES_NOMINATIM_URL,
		userAgent: process.env.PIXIES_USER_AGENT,
		host: process.env.PIXIES_HOST,
		port: process.env.PIXIES_PORT !== undefined ? Number(process.env.PIXIES_PORT) : undefined,
		thinkingLevel: process.env.PIXIES_THINKING_LEVEL,
		dbFile: process.env.PIXIES_DB_FILE,
		cacheSize:
			process.env.PIXIES_CACHE_SIZE !== undefined
				? Number(process.env.PIXIES_CACHE_SIZE)
				: undefined,
		httpRateLimit:
			process.env.PIXIES_HTTP_RATE_LIMIT !== undefined
				? Number(process.env.PIXIES_HTTP_RATE_LIMIT)
				: undefined,
		httpRateLimitWindowMs:
			process.env.PIXIES_HTTP_RATE_LIMIT_WINDOW_MS !== undefined
				? Number(process.env.PIXIES_HTTP_RATE_LIMIT_WINDOW_MS)
				: undefined,
		trustProxy: process.env.PIXIES_TRUST_PROXY === "true",
		nominatimConcurrency:
			process.env.PIXIES_NOMINATIM_CONCURRENCY !== undefined
				? Number(process.env.PIXIES_NOMINATIM_CONCURRENCY)
				: undefined,
		nominatimIntervalCap:
			process.env.PIXIES_NOMINATIM_INTERVAL_CAP !== undefined
				? Number(process.env.PIXIES_NOMINATIM_INTERVAL_CAP)
				: undefined,
		nominatimIntervalMs:
			process.env.PIXIES_NOMINATIM_INTERVAL_MS !== undefined
				? Number(process.env.PIXIES_NOMINATIM_INTERVAL_MS)
				: undefined,
		overpassConcurrency:
			process.env.PIXIES_OVERPASS_CONCURRENCY !== undefined
				? Number(process.env.PIXIES_OVERPASS_CONCURRENCY)
				: undefined,
		overpassIntervalCap:
			process.env.PIXIES_OVERPASS_INTERVAL_CAP !== undefined
				? Number(process.env.PIXIES_OVERPASS_INTERVAL_CAP)
				: undefined,
		overpassIntervalMs:
			process.env.PIXIES_OVERPASS_INTERVAL_MS !== undefined
				? Number(process.env.PIXIES_OVERPASS_INTERVAL_MS)
				: undefined,
	};

	return PixiesConfigSchema.parse(raw);
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

export interface CreateOsmClientsOptions {
	overpassUrl: string;
	nominatimUrl: string;
	contactEmail?: string;
	userAgent: string;
	fetch?: typeof globalThis.fetch;
	nominatimConcurrency?: number;
	nominatimIntervalCap?: number;
	nominatimIntervalMs?: number;
	overpassConcurrency?: number;
	overpassIntervalCap?: number;
	overpassIntervalMs?: number;
}

export function createOsmClients(options: CreateOsmClientsOptions): OsmClients {
	return {
		nominatim: new NominatimClient({
			baseUrl: options.nominatimUrl,
			contactEmail: options.contactEmail,
			userAgent: options.userAgent,
			fetch: options.fetch,
			concurrency: options.nominatimConcurrency,
			intervalCap: options.nominatimIntervalCap,
			intervalMs: options.nominatimIntervalMs,
		}),
		overpass: new OverpassClient({
			baseUrl: options.overpassUrl,
			userAgent: options.userAgent,
			fetch: options.fetch,
			concurrency: options.overpassConcurrency,
			intervalCap: options.overpassIntervalCap,
			intervalMs: options.overpassIntervalMs,
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
