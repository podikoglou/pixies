import { Agent } from "@earendil-works/pi-agent-core";
import { getModels } from "@earendil-works/pi-ai";
import type { Api, KnownProvider, Model } from "@earendil-works/pi-ai";
import { tools } from "./tools/index.ts";

const SYSTEM_PROMPT = `You are Pixies, an AI agent that answers questions about places using OpenStreetMap data.

You help users find places, understand geographic distributions, and explore the world through OSM tags and data. Present results clearly: use tables for lists, include coordinates and permalinks to openstreetmap.org when relevant, and summarize counts when asked.`;

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

const model = resolveModel();

export const agent = new Agent({
	initialState: {
		systemPrompt: SYSTEM_PROMPT,
		model,
		thinkingLevel: "off",
		tools,
	},
});

export { model };
