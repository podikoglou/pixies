import {
	type Agent,
	type AgentEvent,
	type AgentMessage,
	uuidv7,
} from "@earendil-works/pi-agent-core";
import { eq } from "drizzle-orm";
import {
	createAgent,
	createOsmClients,
	conversations as conversationsTable,
	type DbClient,
	type OsmClients,
	type ResolvedPixiesConfig,
} from "@pixies/core";

interface Conversation {
	readonly id: string;
	readonly agent: Agent;
	lastActivity: number;
	inFlight: boolean;
}

export type StreamPromptResult =
	| { ok: true; stream: ReadableStream<AgentEvent> }
	| { ok: false; reason: "not_found" | "conflict" };

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export class ConversationStore {
	private readonly map = new Map<string, Conversation>();
	private readonly sweeper: ReturnType<typeof setInterval>;
	private readonly config: ResolvedPixiesConfig;
	private readonly osmClients: OsmClients;
	private readonly db: DbClient;
	private readonly maxSize: number;

	constructor(config: ResolvedPixiesConfig, db: DbClient) {
		this.config = config;
		this.db = db;
		this.maxSize = config.cacheSize;
		this.osmClients = createOsmClients({
			overpassUrl: config.overpassUrl,
			nominatimUrl: config.nominatimUrl,
			contactEmail: config.contactEmail,
			userAgent: config.userAgent,
		});
		this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
	}

	create(): string {
		const id = uuidv7();
		const conv: Conversation = {
			id,
			agent: createAgent({ config: this.config, osmClients: this.osmClients }),
			lastActivity: Date.now(),
			inFlight: false,
		};
		this.map.set(conv.id, conv);
		this.evictIfNeeded();
		this.db
			.insert(conversationsTable)
			.values({ id, transcript: [] })
			.catch(() => {});
		return conv.id;
	}

	async get(id: string): Promise<Conversation | undefined> {
		let conv = this.map.get(id);
		if (conv) {
			this.map.delete(id);
			this.map.set(id, conv);
			conv.lastActivity = Date.now();
			return conv;
		}

		const rows = await this.db
			.select()
			.from(conversationsTable)
			.where(eq(conversationsTable.id, id))
			.limit(1);

		if (rows.length === 0) return undefined;

		const row = rows[0]!;
		conv = {
			id,
			agent: createAgent({ config: this.config, osmClients: this.osmClients }),
			lastActivity: Date.now(),
			inFlight: false,
		};

		if (row.transcript && row.transcript.length > 0) {
			conv.agent.state.messages = row.transcript as AgentMessage[];
		}

		this.map.set(id, conv);
		this.evictIfNeeded();
		return conv;
	}

	streamPrompt(id: string, message: string): StreamPromptResult {
		const conv = this.map.get(id);
		if (!conv) return { ok: false, reason: "not_found" };
		if (conv.inFlight) return { ok: false, reason: "conflict" };
		conv.inFlight = true;
		conv.lastActivity = Date.now();
		this.map.delete(id);
		this.map.set(id, conv);

		const stream = new ReadableStream<AgentEvent>({
			start: (controller) => {
				const unsubscribe = conv.agent.subscribe((event: AgentEvent) => controller.enqueue(event));
				conv.agent
					.prompt(message)
					.then(
						() => {
							try {
								controller.close();
							} catch {
								// already closed
							}
						},
						(err) => controller.error(err),
					)
					.finally(() => {
						unsubscribe();
						conv.inFlight = false;
						this.db
							.update(conversationsTable)
							.set({
								transcript: conv.agent.state.messages as AgentMessage[],
								updatedAt: new Date(),
							})
							.where(eq(conversationsTable.id, id))
							.catch(() => {});
					});
			},
		});

		return { ok: true, stream };
	}

	abort(id: string): void {
		const conv = this.map.get(id);
		if (conv) this.abortConversation(conv);
	}

	delete(id: string): boolean {
		const conv = this.map.get(id);
		if (!conv) return false;
		this.abortConversation(conv);
		this.map.delete(id);
		this.db
			.delete(conversationsTable)
			.where(eq(conversationsTable.id, id))
			.catch(() => {});
		return true;
	}

	size(): number {
		return this.map.size;
	}

	stop(): void {
		clearInterval(this.sweeper);
	}

	private abortConversation(conv: Conversation): void {
		conv.agent.abort();
	}

	private evictIfNeeded(): void {
		while (this.map.size > this.maxSize) {
			const key = this.map.keys().next().value;
			if (key === undefined) break;
			const conv = this.map.get(key);
			if (conv) this.abortConversation(conv);
			this.map.delete(key);
		}
	}

	private sweep(): void {
		const now = Date.now();
		for (const conv of this.map.values()) {
			if (now - conv.lastActivity > 24 * 60 * 60 * 1000) {
				this.abortConversation(conv);
				this.map.delete(conv.id);
			}
		}
	}
}
