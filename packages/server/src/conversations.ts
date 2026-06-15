import { type Agent, uuidv7 } from "@earendil-works/pi-agent-core";
import { createAgent, type ResolvedPixiesConfig } from "@pixies/core";

export interface Conversation {
	readonly id: string;
	readonly agent: Agent;
	lastActivity: number;
	inFlight: boolean;
}

const TTL_MS = 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export class ConversationStore {
	private readonly conversations = new Map<string, Conversation>();
	private readonly sweeper: ReturnType<typeof setInterval>;
	private readonly config: ResolvedPixiesConfig;

	constructor(config: ResolvedPixiesConfig) {
		this.config = config;
		this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
	}

	create(): Conversation {
		const conv: Conversation = {
			id: uuidv7(),
			agent: createAgent({ config: this.config }),
			lastActivity: Date.now(),
			inFlight: false,
		};
		this.conversations.set(conv.id, conv);
		return conv;
	}

	get(id: string): Conversation | undefined {
		const conv = this.conversations.get(id);
		if (conv) conv.lastActivity = Date.now();
		return conv;
	}

	delete(id: string): boolean {
		const conv = this.conversations.get(id);
		if (!conv) return false;
		if (conv.agent.state.isStreaming) conv.agent.abort();
		this.conversations.delete(id);
		return true;
	}

	size(): number {
		return this.conversations.size;
	}

	stop(): void {
		clearInterval(this.sweeper);
	}

	private sweep(): void {
		const now = Date.now();
		for (const conv of this.conversations.values()) {
			if (now - conv.lastActivity > TTL_MS) {
				if (conv.agent.state.isStreaming) conv.agent.abort();
				this.conversations.delete(conv.id);
			}
		}
	}
}
