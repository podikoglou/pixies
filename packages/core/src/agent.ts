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
		maxConversations:
			process.env.PIXIES_MAX_CONVERSATIONS !== undefined
				? Number(process.env.PIXIES_MAX_CONVERSATIONS)
				: undefined,
		maxMessages:
			process.env.PIXIES_MAX_MESSAGES !== undefined
				? Number(process.env.PIXIES_MAX_MESSAGES)
				: undefined,
		logLevel: process.env.PIXIES_LOG_LEVEL,
		defaultLimit:
			process.env.PIXIES_DEFAULT_LIMIT !== undefined
				? Number(process.env.PIXIES_DEFAULT_LIMIT)
				: undefined,
	};

	return PixiesConfigSchema.parse(raw);
}

export interface CreateAgentOptions {
	config: ResolvedPixiesConfig;
	fetch?: typeof globalThis.fetch;
}

export interface CreateOsmClientsOptions {
	overpassUrl: string;
	nominatimUrl: string;
	contactEmail?: string;
	userAgent: string;
	fetch?: typeof globalThis.fetch;
}

export function createOsmClients(options: CreateOsmClientsOptions): OsmClients {
	return {
		nominatim: new NominatimClient({
			baseUrl: options.nominatimUrl,
			contactEmail: options.contactEmail,
			userAgent: options.userAgent,
			fetch: options.fetch,
		}),
		overpass: new OverpassClient({
			baseUrl: options.overpassUrl,
			userAgent: options.userAgent,
			fetch: options.fetch,
		}),
	};
}

export function createAgent(options: CreateAgentOptions): Agent {
	const { config } = options;
	const model = resolveModel(config.model);
	const clients = createOsmClients({
		overpassUrl: config.overpassUrl,
		nominatimUrl: config.nominatimUrl,
		contactEmail: config.contactEmail,
		userAgent: config.userAgent,
		fetch: options.fetch,
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
