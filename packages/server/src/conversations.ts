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

interface Conversation {
	readonly id: string;
	readonly agent: Agent;
	lastActivity: number;
	inFlight: boolean;
	tokensUsed: number;
}

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export class ConversationStore {
	private map = new Map<string, Conversation>();
	private sweeper: ReturnType<typeof setInterval>;
	private config: ResolvedPixiesConfig;
	private nominatim: NominatimClient;
	private overpass: OverpassClient;
	private db: DbClient;
	private maxSize: number;
	private agentFactory: (opts: CreateAgentOptions) => Agent;
	private logger: Logger;

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
		const conv: Conversation = {
			id,
			agent: this.agentFactory({
				config: this.config,
				nominatim: this.nominatim,
				overpass: this.overpass,
			}),
			lastActivity: Date.now(),
			inFlight: false,
			tokensUsed: 0,
		};
		this.map.set(conv.id, conv);
		this.evictIfNeeded();
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
		return conv.id;
	}

	async get(id: string): Promise<Conversation | undefined> {
		return this.loadConversation(id);
	}

	/**
	 * Resolve a conversation by id from cache or DB — the single owner of the
	 * cache-miss load path previously duplicated by `get()` and `streamPrompt()`.
	 *
	 * On a cache hit it touches the LRU (move to tail + bump `lastActivity`)
	 * and returns the live conversation, replicating the prior `get()` cache-hit
	 * behavior. On a miss it loads the persisted row, builds a fresh
	 * `Conversation`, rehydrates its transcript, and inserts it under eviction.
	 * A missing row yields `undefined`, leaving the not-found mapping to each
	 * caller: `get()` returns `undefined`; `streamPrompt()` maps it to
	 * `Err(ConversationNotFoundError)` at its own call site.
	 *
	 * `streamPrompt()` pre-checks the cache and only routes the *miss* through
	 * here, so its separate LRU re-touch (after the in-flight/budget guards) is
	 * unchanged. Centralizing the miss path means the ADR-0008 persisted-
	 * transcript guard (`isPersistedTranscript`, called once inside
	 * `rehydrateTranscript`) is trusted from exactly one read site instead of
	 * two duplicated copies that had to stay in lockstep.
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
		conv = {
			id,
			agent: this.agentFactory({
				config: this.config,
				nominatim: this.nominatim,
				overpass: this.overpass,
			}),
			lastActivity: Date.now(),
			inFlight: false,
			tokensUsed: 0,
		};

		if (row.transcript && row.transcript.length > 0) {
			this.rehydrateTranscript(conv, row.transcript, id);
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
