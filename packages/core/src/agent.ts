import { Agent } from "@earendil-works/pi-agent-core";
import { getModels } from "@earendil-works/pi-ai";
import type { Api, KnownProvider, Model } from "@earendil-works/pi-ai";
import { type PixiesConfig } from "./config-schema.ts";
import { resolveOsmConfig } from "./osm/config.ts";
import { NominatimClient } from "./osm/nominatim.ts";
import { OverpassClient } from "./osm/overpass.ts";
import { createTools, type OsmClients } from "./tools/index.ts";
import { SYSTEM_PROMPT } from "./system-prompt.ts";

export type { PixiesConfig } from "./config-schema.ts";

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

function parseThinkingLevel(
	raw: string | undefined,
): "off" | "low" | "medium" | "high" | undefined {
	if (!raw) return undefined;
	const level = raw.toLowerCase();
	if (level !== "off" && level !== "low" && level !== "medium" && level !== "high") {
		throw new Error(`Invalid PIXIES_THINKING_LEVEL: "${raw}". Must be off|low|medium|high.`);
	}
	return level;
}

function parseLogLevel(raw: string | undefined): "debug" | "info" | "warn" | "error" | undefined {
	if (!raw) return undefined;
	const level = raw.toLowerCase();
	if (level !== "debug" && level !== "info" && level !== "warn" && level !== "error") {
		throw new Error(`Invalid PIXIES_LOG_LEVEL: "${raw}". Must be debug|info|warn|error.`);
	}
	return level;
}

export function readConfigFromEnv(): PixiesConfig {
	const apiKey = process.env.PIXIES_API_KEY;
	if (!apiKey) throw new Error("PIXIES_API_KEY is not set.");

	const modelRef = process.env.PIXIES_MODEL;
	if (!modelRef) {
		throw new Error(
			'PIXIES_MODEL is not set. Expected format: "provider/model-id" (e.g. "anthropic/claude-sonnet-4-20250514")',
		);
	}

	if (!modelRef.includes("/")) {
		throw new Error(`Model must be in "provider/model-id" format. Got: "${modelRef}"`);
	}

	return {
		model: modelRef,
		apiKey,
		contactEmail: process.env.PIXIES_CONTACT_EMAIL,
		overpassUrl: process.env.PIXIES_OVERPASS_URL,
		nominatimUrl: process.env.PIXIES_NOMINATIM_URL,
		userAgent: process.env.PIXIES_USER_AGENT,
		host: process.env.PIXIES_HOST ?? "127.0.0.1",
		port: Number(process.env.PIXIES_PORT ?? "3000"),
		thinkingLevel: parseThinkingLevel(process.env.PIXIES_THINKING_LEVEL),
		maxConversations: Number(process.env.PIXIES_MAX_CONVERSATIONS ?? "100"),
		maxMessages: Number(process.env.PIXIES_MAX_MESSAGES ?? "50"),
		logLevel: parseLogLevel(process.env.PIXIES_LOG_LEVEL),
		defaultLimit: Number(process.env.PIXIES_DEFAULT_LIMIT ?? "10"),
	};
}

export interface CreateAgentOptions {
	config: PixiesConfig;
	fetch?: typeof globalThis.fetch;
}

export interface CreateOsmClientsOptions {
	osm?: { overpassUrl?: string; nominatimUrl?: string; contactEmail?: string; userAgent?: string };
	fetch?: typeof globalThis.fetch;
}

export function createOsmClients(options?: CreateOsmClientsOptions): OsmClients {
	const osmConfig = resolveOsmConfig(options?.osm);
	const fetchFn = options?.fetch;
	return {
		nominatim: new NominatimClient({
			baseUrl: osmConfig.nominatimUrl,
			contactEmail: osmConfig.contactEmail,
			userAgent: osmConfig.userAgent,
			fetch: fetchFn,
		}),
		overpass: new OverpassClient({
			baseUrl: osmConfig.overpassUrl,
			userAgent: osmConfig.userAgent,
			fetch: fetchFn,
		}),
	};
}

export function createAgent(options: CreateAgentOptions): Agent {
	const { config } = options;
	const model = resolveModel(config.model);
	const clients = createOsmClients({
		osm: {
			overpassUrl: config.overpassUrl,
			nominatimUrl: config.nominatimUrl,
			contactEmail: config.contactEmail,
			userAgent: config.userAgent,
		},
		fetch: options.fetch,
	});
	const tools = createTools(clients);
	return new Agent({
		initialState: {
			systemPrompt: SYSTEM_PROMPT,
			model,
			thinkingLevel: config.thinkingLevel ?? "off",
			tools,
		},
		getApiKey: () => config.apiKey,
	});
}
