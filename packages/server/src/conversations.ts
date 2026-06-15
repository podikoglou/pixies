import { type Agent, type AgentEvent, uuidv7 } from "@earendil-works/pi-agent-core";
import {
	createAgent,
	createOsmClients,
	type OsmClients,
	type ResolvedPixiesConfig,
} from "@pixies/core";

/**
 * A live conversation: an agent plus the lifecycle state the store owns.
 *
 * `inFlight` is the store's private signal that a prompt stream is running on
 * this conversation. It is mutated only inside {@link ConversationStore} —
 * never from a route handler. The store guarantees `inFlight` is set in the
 * same synchronous tick as the 409 check, so `inFlight ⟺ agent.state.isStreaming`
 * holds across every observable transition.
 */
interface Conversation {
	readonly id: string;
	readonly agent: Agent;
	lastActivity: number;
	inFlight: boolean;
}

/**
 * Outcome of {@link ConversationStore.streamPrompt}.
 *
 * - `ok`: the caller owns a `stream` of {@link AgentEvent}s to pipe to its SSE
 *   writer. The store has already set `inFlight`, started `agent.prompt()`, and
 *   registered the `.finally()` that clears `inFlight` and closes the stream.
 * - `not_found`: no conversation with that id; caller returns 404.
 * - `conflict`: a prompt is already in-flight; caller returns 409.
 */
export type StreamPromptResult =
	| { ok: true; stream: ReadableStream<AgentEvent> }
	| { ok: false; reason: "not_found" | "conflict" };

const TTL_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export class ConversationStore {
	private readonly conversations = new Map<string, Conversation>();
	private readonly sweeper: ReturnType<typeof setInterval>;
	private readonly config: ResolvedPixiesConfig;
	/**
	 * Single OSM client pair per process. Shared across every conversation so
	 * the Nominatim rate-limit chain serializes requests globally (Nominatim's
	 * usage policy is 1 req/s per source IP, not per client instance). See
	 * ADR-0004.
	 */
	private readonly osmClients: OsmClients;

	constructor(config: ResolvedPixiesConfig) {
		this.config = config;
		this.osmClients = createOsmClients({
			overpassUrl: config.overpassUrl,
			nominatimUrl: config.nominatimUrl,
			contactEmail: config.contactEmail,
			userAgent: config.userAgent,
		});
		this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
	}

	/** Create a new conversation and return its id. */
	create(): string {
		const conv: Conversation = {
			id: uuidv7(),
			agent: createAgent({ config: this.config, osmClients: this.osmClients }),
			lastActivity: Date.now(),
			inFlight: false,
		};
		this.conversations.set(conv.id, conv);
		return conv.id;
	}

	/**
	 * Look up a conversation by id and refresh its TTL. Returns `undefined`
	 * when no such conversation exists.
	 */
	get(id: string): Conversation | undefined {
		const conv = this.conversations.get(id);
		if (conv) conv.lastActivity = Date.now();
		return conv;
	}

	/**
	 * Start streaming a prompt for an existing conversation.
	 *
	 * The 409 check and the `inFlight = true` assignment run in the same
	 * synchronous tick — there is no `await` between them — so two concurrent
	 * POSTs cannot both pass the guard. One wins, the other gets `conflict`.
	 *
	 * The store owns the full stream lifecycle from here:
	 *
	 *   1. `inFlight = true` (above).
	 *   2. Subscribe to agent events and forward them through the returned
	 *      stream.
	 *   3. Call `agent.prompt()`.
	 *   4. On settle: unsubscribe, clear `inFlight`, close the stream.
	 *
	 * `inFlight ⟺ agent.state.isStreaming` follows: the flag is set just
	 * before `prompt()` is called and cleared in `.finally()`, which runs only
	 * after the agent's run — and thus `isStreaming` — has settled.
	 *
	 * Client-disconnect abort is NOT wired here; the route handler forwards
	 * disconnect via {@link abort}, which funnels through the same seam as
	 * {@link delete} and {@link sweep}.
	 */
	streamPrompt(id: string, message: string): StreamPromptResult {
		const conv = this.conversations.get(id);
		if (!conv) return { ok: false, reason: "not_found" };
		// Atomic check-and-set: no await between read and write.
		if (conv.inFlight) return { ok: false, reason: "conflict" };
		conv.inFlight = true;
		conv.lastActivity = Date.now();

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
								// already closed (e.g. consumer cancelled) — nothing to do
							}
						},
						(err) => controller.error(err),
					)
					.finally(() => {
						unsubscribe();
						conv.inFlight = false;
					});
			},
		});

		return { ok: true, stream };
	}

	/**
	 * Abort any in-flight prompt for a conversation. This is the single seam
	 * for the client-disconnect trigger; {@link delete} and {@link sweep} share
	 * the same underlying path via {@link abortConversation}.
	 *
	 * Idempotent: `Agent.abort()` is a no-op when no run is active, so calling
	 * this on an idle conversation (or double-aborting on disconnect + DELETE)
	 * is explicitly safe.
	 */
	abort(id: string): void {
		const conv = this.conversations.get(id);
		if (conv) this.abortConversation(conv);
	}

	/**
	 * Remove a conversation from memory, aborting any in-flight prompt first.
	 * Returns `false` if no such conversation existed.
	 */
	delete(id: string): boolean {
		const conv = this.conversations.get(id);
		if (!conv) return false;
		this.abortConversation(conv);
		this.conversations.delete(id);
		return true;
	}

	size(): number {
		return this.conversations.size;
	}

	stop(): void {
		clearInterval(this.sweeper);
	}

	/** Single internal path every abort trigger funnels through. */
	private abortConversation(conv: Conversation): void {
		conv.agent.abort();
	}

	private sweep(): void {
		const now = Date.now();
		for (const conv of this.conversations.values()) {
			if (now - conv.lastActivity > TTL_MS) {
				this.abortConversation(conv);
				this.conversations.delete(conv.id);
			}
		}
	}
}
