import { Agent } from "@earendil-works/pi-agent-core";
import { getModels } from "@earendil-works/pi-ai";
import type { Api, KnownProvider, Model } from "@earendil-works/pi-ai";
import { resolveOsmConfig } from "./osm/config.ts";
import { NominatimClient } from "./osm/nominatim.ts";
import { OverpassClient } from "./osm/overpass.ts";
import { createTools, type OsmClients } from "./tools/index.ts";
import { SYSTEM_PROMPT } from "./system-prompt.ts";

function resolveModel(): Model<Api> {
	const ref = process.env.PIXIES_MODEL;
	if (!ref) {
		console.error(
			'PIXIES_MODEL is not set. Expected format: "provider/model-id" (e.g. "anthropic/claude-sonnet-4-20250514")',
		);
		process.exit(1);
	}

	const slashIndex = ref.indexOf("/");
	if (slashIndex === -1) {
		console.error(`PIXIES_MODEL must be in "provider/model-id" format. Got: "${ref}"`);
		process.exit(1);
	}

	const provider = ref.slice(0, slashIndex);
	const modelId = ref.slice(slashIndex + 1);

	const models = getModels(provider as KnownProvider) as Model<Api>[];
	const model = models.find((m) => m.id === modelId);
	if (!model) {
		console.error(`Unknown model: "${ref}". Check provider and model ID.`);
		process.exit(1);
	}

	return model;
}

export interface CreateAgentOptions {
	osm?: {
		overpassUrl?: string;
		nominatimUrl?: string;
		contactEmail?: string;
		userAgent?: string;
	};
	fetch?: typeof globalThis.fetch;
}

export function createOsmClients(options?: CreateAgentOptions): OsmClients {
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

export function createAgent(options?: CreateAgentOptions): Agent {
	const apiKey = process.env.PIXIES_API_KEY;
	if (!apiKey) {
		console.error("PIXIES_API_KEY is not set.");
		process.exit(1);
	}
	const model = resolveModel();
	const clients = createOsmClients(options);
	const tools = createTools(clients);
	return new Agent({
		initialState: { systemPrompt: SYSTEM_PROMPT, model, thinkingLevel: "off", tools },
		getApiKey: () => apiKey,
	});
}
