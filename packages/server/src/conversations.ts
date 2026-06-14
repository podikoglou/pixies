import type { Agent } from "@earendil-works/pi-agent-core";
import { createAgent } from "@pixies/core";

export interface Conversation {
	readonly id: string;
	readonly agent: Agent;
	lastActivity: number;
	inFlight: boolean;
}

const TTL_MS = 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

function uuidV7(): string {
	const bytes = new Uint8Array(16);
	const view = new DataView(bytes.buffer);
	const ts = BigInt(Date.now());
	view.setUint32(0, Number(ts >> 16n));
	view.setUint16(4, Number(ts & 0xFFFFn));
	crypto.getRandomValues(bytes.subarray(6));
	bytes[6] = (bytes[6]! & 0x0F) | 0x70;
	bytes[8] = (bytes[8]! & 0x3F) | 0x80;
	const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export class ConversationStore {
	private readonly conversations = new Map<string, Conversation>();
	private readonly sweeper: ReturnType<typeof setInterval>;

	constructor() {
		this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
	}

	create(): Conversation {
		const conv: Conversation = {
			id: uuidV7(),
			agent: createAgent(),
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
