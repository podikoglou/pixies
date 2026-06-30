import {
	type Agent,
	type AgentEvent,
	type AgentMessage,
	uuidv7,
} from "@earendil-works/pi-agent-core";
import { eq } from "drizzle-orm";
import {
	createAgent,
	createNominatimClient,
	createOverpassClient,
	isPersistedTranscript,
	Result,
	ConversationNotFoundError,
	PromptConflictError,
	countTranscriptTokens,
	budgetExceeded,
	type CreateAgentOptions,
	type NominatimClient,
	type OverpassClient,
	type ResolvedPixiesConfig,
	type StreamPromptError,
} from "@pixies/core";
import { conversations as conversationsTable, type DbClient } from "@pixies/core/db";
import { silentLogger, type Logger } from "@pixies/core/logging";
import { MontyExecutor } from "./sandbox/monty-executor.ts";

interface Conversation {
	readonly id: string;
	readonly agent: Agent;
	readonly executor: MontyExecutor;
	lastActivity: number;
	inFlight: boolean;
	tokensUsed: number;
}

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export class ConversationStore {
	private readonly map = new Map<string, Conversation>();
	private readonly sweeper: ReturnType<typeof setInterval>;
	private readonly config: ResolvedPixiesConfig;
	private readonly nominatim: NominatimClient;
	private readonly overpass: OverpassClient;
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
		// One client per service per process (ADR-0004). Constructed once here
		// and injected into every agent so each service's rate-limit chain is
		// process-global, independent of conversation count.
		this.nominatim = createNominatimClient(config, { logger: this.logger });
		this.overpass = createOverpassClient(config, { logger: this.logger });
		this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
	}

	create(): string {
		const id = uuidv7();
		this.buildConversation(id);
		void Result.tryPromise(() =>
			this.db.insert(conversationsTable).values({ id, transcript: [] }),
		).then((r) =>
			r.tapError((e) =>
				this.logger.error("failed to insert conversation", {
					conversationId: id,
					err: e.cause ?? e,
				}),
			),
		);
		return id;
	}

	async get(id: string): Promise<Conversation | undefined> {
		return this.loadConversation(id);
	}

	/**
	 * Load a conversation from cache or DB.
	 *
	 * Cache hit: LRU-touches and returns. Cache miss: queries DB, builds a
	 * fresh `Conversation`, rehydrates the transcript, inserts into the map
	 * under eviction, and returns. A missing row yields `undefined` — the
	 * caller maps that to a domain error.
	 *
	 * Single read-site for the ADR-0008 persisted-transcript guard
	 * (`isPersistedTranscript`). Callers must not bypass.
	 */
	private async loadConversation(id: string): Promise<Conversation | undefined> {
		let conv = this.map.get(id);
		if (conv) {
			// Cache hit: move to LRU tail and refresh activity so it survives eviction.
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
		conv = this.buildConversation(id);
		if (row.transcript && row.transcript.length > 0) {
			this.rehydrateTranscript(conv, row.transcript, id);
		}
		return conv;
	}

	async streamPrompt(
		id: string,
		message: string,
	): Promise<Result<{ stream: ReadableStream<AgentEvent> }, StreamPromptError>> {
		let conv = this.map.get(id);
		if (!conv) {
			// Cache miss: route through the shared loader. Not-found is mapped
			// to Err(ConversationNotFoundError) here, at the call site — the
			// loader returns undefined for a missing row. On a hit the loader
			// is skipped, so the LRU re-touch below (after the guards) stays
			// the sole cache ordering for this path.
			conv = await this.loadConversation(id);
			if (!conv)
				return Result.err(
					new ConversationNotFoundError({ id, message: `conversation not found: ${id}` }),
				);
		}
		if (conv.inFlight)
			return Result.err(
				new PromptConflictError({ id, message: "conversation already has an in-flight prompt" }),
			);

		// Budget guard reads the STORED tokensUsed (not a fresh recount) —
		// preserving the historical semantics where the cap is checked against
		// the count persisted from the previous turn's `.finally`.
		const exceeded = budgetExceeded(conv.tokensUsed, this.config.conversationTokenBudget);
		if (exceeded) return Result.err(exceeded);

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
						// Recount uses `.total` only — live messages always carry
						// usage, and warning here would fire every turn.
						conv.tokensUsed = countTranscriptTokens(conv.agent.state.messages).total;
						conv.inFlight = false;
						void Result.tryPromise(() =>
							this.db
								.update(conversationsTable)
								.set({
									transcript: conv.agent.state.messages as AgentMessage[],
									updatedAt: new Date(),
								})
								.where(eq(conversationsTable.id, id)),
						).then((r) =>
							r.tapError((e) =>
								this.logger.error("failed to persist transcript", {
									conversationId: id,
									err: e.cause ?? e,
								}),
							),
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
		void Result.tryPromise(() =>
			this.db.delete(conversationsTable).where(eq(conversationsTable.id, id)),
		).then((r) =>
			r.tapError((e) =>
				this.logger.error("failed to delete conversation", {
					conversationId: id,
					err: e.cause ?? e,
				}),
			),
		);
		return true;
	}

	size(): number {
		return this.map.size;
	}

	stop(): void {
		clearInterval(this.sweeper);
	}

	private buildConversation(id: string): Conversation {
		const executor = new MontyExecutor({ nominatim: this.nominatim, overpass: this.overpass });
		const conv: Conversation = {
			id,
			agent: this.agentFactory({
				config: this.config,
				codeExecutor: executor,
			}),
			executor,
			lastActivity: Date.now(),
			inFlight: false,
			tokensUsed: 0,
		};
		this.map.set(id, conv);
		this.evictIfNeeded();
		return conv;
	}

	private abortConversation(conv: Conversation): void {
		conv.agent.abort();
	}

	/**
	 * Validate and load a persisted transcript into a fresh conversation's agent
	 * state. Gross corruption (see `PersistedTranscriptSchema` in `@pixies/core`)
	 * is warn-logged and the conversation starts empty rather than mis-typing the
	 * in-memory agent state — the user still gets a working conversation; the
	 * operator gets a `warn` line with the conversationId and entry count.
	 */
	private rehydrateTranscript(conv: Conversation, transcript: unknown, id: string): void {
		if (!Array.isArray(transcript) || transcript.length === 0) return;
		if (!isPersistedTranscript(transcript)) {
			this.logger.warning("transcript failed validation; starting fresh", {
				conversationId: id,
				count: transcript.length,
			});
			return;
		}
		conv.agent.state.messages = transcript;
		// Rehydrated rows are persisted, untrusted data (ADR-0008): an assistant
		// message written by an older binary may lack `usage`, undercounting the
		// budget. The count surfaces that as `missingUsage`; warn once at load so
		// the silent undercount becomes a signaled one (consistent with the
		// corrupt-transcript warn above), rather than rejecting the row outright.
		const count = countTranscriptTokens(conv.agent.state.messages);
		conv.tokensUsed = count.total;
		if (count.missingUsage > 0) {
			this.logger.warning(
				"rehydrated transcript has assistant messages missing usage; token budget undercounted",
				{
					conversationId: id,
					missingUsage: count.missingUsage,
				},
			);
		}
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
