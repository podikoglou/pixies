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
	Result,
	ConversationNotFoundError,
	PromptConflictError,
	BudgetExceededError,
	type CreateAgentOptions,
	type OsmClients,
	type ResolvedPixiesConfig,
	type StreamPromptError,
} from "@pixies/core";
import { conversations as conversationsTable, type DbClient } from "@pixies/core/db";
import { silentLogger, type Logger } from "@pixies/core/logging";

function computeTokensUsed(messages: AgentMessage[]): number {
	let total = 0;
	for (const msg of messages) {
		if (msg.role === "assistant" && typeof (msg as any).usage?.totalTokens === "number") {
			total += (msg as any).usage.totalTokens;
		}
	}
	return total;
}

interface Conversation {
	readonly id: string;
	readonly agent: Agent;
	lastActivity: number;
	inFlight: boolean;
	tokensUsed: number;
}

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export class ConversationStore {
	private readonly map = new Map<string, Conversation>();
	private readonly sweeper: ReturnType<typeof setInterval>;
	private readonly config: ResolvedPixiesConfig;
	private readonly osmClients: OsmClients;
	private readonly db: DbClient;
	private readonly maxSize: number;
	private readonly agentFactory: (opts: CreateAgentOptions) => Agent;
	private readonly logger: Logger;

	constructor(
		config: ResolvedPixiesConfig,
		db: DbClient,
		agentFactory: (opts: CreateAgentOptions) => Agent = createAgent,
		logger: Logger = silentLogger,
	) {
		this.config = config;
		this.db = db;
		this.maxSize = config.cacheSize;
		this.agentFactory = agentFactory;
		this.logger = logger;
		this.osmClients = createOsmClients({
			overpassUrl: config.overpassUrl,
			nominatimUrl: config.nominatimUrl,
			contactEmail: config.contactEmail,
			userAgent: config.userAgent,
			nominatimConcurrency: config.nominatimConcurrency,
			nominatimIntervalCap: config.nominatimIntervalCap,
			nominatimIntervalMs: config.nominatimIntervalMs,
			nominatimCacheTtlMs: config.nominatimCacheTtlMs,
			nominatimCacheMaxEntries: config.nominatimCacheMaxEntries,
			overpassConcurrency: config.overpassConcurrency,
			overpassIntervalCap: config.overpassIntervalCap,
			overpassIntervalMs: config.overpassIntervalMs,
			logger: this.logger,
		});
		this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
	}

	create(): string {
		const id = uuidv7();
		const conv: Conversation = {
			id,
			agent: this.agentFactory({ config: this.config, osmClients: this.osmClients }),
			lastActivity: Date.now(),
			inFlight: false,
			tokensUsed: 0,
		};
		this.map.set(conv.id, conv);
		this.evictIfNeeded();
		this.db
			.insert(conversationsTable)
			.values({ id, transcript: [] })
			.catch((err) =>
				this.logger.error({ conversationId: id, err }, "failed to insert conversation"),
			);
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
			agent: this.agentFactory({ config: this.config, osmClients: this.osmClients }),
			lastActivity: Date.now(),
			inFlight: false,
			tokensUsed: 0,
		};

		if (row.transcript && row.transcript.length > 0) {
			conv.agent.state.messages = row.transcript as AgentMessage[];
			conv.tokensUsed = computeTokensUsed(conv.agent.state.messages);
		}

		this.map.set(id, conv);
		this.evictIfNeeded();
		return conv;
	}

	async streamPrompt(
		id: string,
		message: string,
	): Promise<Result<{ stream: ReadableStream<AgentEvent> }, StreamPromptError>> {
		let conv = this.map.get(id);
		if (!conv) {
			const rows = await this.db
				.select()
				.from(conversationsTable)
				.where(eq(conversationsTable.id, id))
				.limit(1);

			if (rows.length === 0)
				return Result.err(
					new ConversationNotFoundError({ id, message: `conversation not found: ${id}` }),
				);

			const row = rows[0]!;
			conv = {
				id,
				agent: this.agentFactory({ config: this.config, osmClients: this.osmClients }),
				lastActivity: Date.now(),
				inFlight: false,
				tokensUsed: 0,
			};

			if (row.transcript && row.transcript.length > 0) {
				conv.agent.state.messages = row.transcript as AgentMessage[];
				conv.tokensUsed = computeTokensUsed(conv.agent.state.messages);
			}

			this.map.set(id, conv);
			this.evictIfNeeded();
		}
		if (conv.inFlight)
			return Result.err(
				new PromptConflictError({ id, message: "conversation already has an in-flight prompt" }),
			);

		const budget = this.config.conversationTokenBudget;
		if (budget > 0 && conv.tokensUsed >= budget) {
			return Result.err(new BudgetExceededError({ used: conv.tokensUsed, budget }));
		}

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
						conv.tokensUsed = computeTokensUsed(conv.agent.state.messages);
						conv.inFlight = false;
						this.db
							.update(conversationsTable)
							.set({
								transcript: conv.agent.state.messages as AgentMessage[],
								updatedAt: new Date(),
							})
							.where(eq(conversationsTable.id, id))
							.catch((err) =>
								this.logger.error({ conversationId: id, err }, "failed to persist transcript"),
							);
					});
			},
		});

		return Result.ok({ stream });
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
			.catch((err) =>
				this.logger.error({ conversationId: id, err }, "failed to delete conversation"),
			);
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

	/**
	 * TTL maintenance — evicts conversations idle > 24h.
	 *
	 * Public so tests can trigger it deterministically; the production trigger
	 * is the constructor's `setInterval` (every `SWEEP_INTERVAL_MS`), which
	 * `bun:test` cannot fast-forward.
	 */
	sweep(): void {
		const now = Date.now();
		for (const conv of this.map.values()) {
			if (now - conv.lastActivity > 24 * 60 * 60 * 1000) {
				this.abortConversation(conv);
				this.map.delete(conv.id);
			}
		}
	}
}
