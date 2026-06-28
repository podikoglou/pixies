import { LRUCache } from "lru-cache";
import type { StoredElement } from "./stored-element.ts";

/**
 * Per-conversation stored result. Only element-bearing successful results
 * are stored — `display_map`, `query_osm` (raw Overpass payload), and any
 * `busy`/errored result are NOT stored, so referencing them is a clean
 * "wrong result kind" error rather than a stale-element silent bug.
 */
export interface StoredResult {
	toolCallId: string;
	toolName: string;
	/** When the result was stored; informs debugging and future TTL eviction. */
	timestamp: number;
	elements: StoredElement[];
}

/**
 * Maximum result-set entries retained per conversation. Sized for the
 * "showcase" multi-step query (≈6 tool calls) plus headroom for follow-up
 * turns. Larger than this and the LRU evicts oldest-first.
 *
 * Co-located with the consumer (`ResultStore`) rather than a `constants.ts`
 * junk-drawer — per CONVENTIONS.local.md §1 (repeated scalar value rule).
 */
const MAX_ENTRIES_PER_CONVERSATION = 64;

/**
 * Per-conversation LRU of element-bearing tool results, keyed by tool call
 * ID. The store backs both intra-turn refs (`filter` → `find_features` in
 * the same batch) and cross-turn refs (`filter` → a previous turn's
 * `find_features`).
 *
 * One store per agent (constructed in `createAgent`, injected via tool
 * context). Lifetime is the conversation's in-memory lifetime; the store
 * is NOT persisted across server restarts — references to pre-restart
 * tool call IDs resolve as "not found", which the dependency layer turns
 * into a tool error the model can recover from in the next turn.
 */
export class ResultStore {
	private readonly cache: LRUCache<string, StoredResult>;

	constructor(maxEntries = MAX_ENTRIES_PER_CONVERSATION) {
		this.cache = new LRUCache({ max: maxEntries });
	}

	/** Store a successful element-bearing result. */
	set(result: StoredResult): void {
		this.cache.set(result.toolCallId, result);
	}

	/** Look up a stored result by tool call ID. `undefined` when absent. */
	get(toolCallId: string): StoredResult | undefined {
		return this.cache.get(toolCallId);
	}

	/** True when a result for the given tool call ID is currently stored. */
	has(toolCallId: string): boolean {
		return this.cache.has(toolCallId);
	}

	/** Drop a stored result by tool call ID. */
	delete(toolCallId: string): void {
		this.cache.delete(toolCallId);
	}

	/** Current entry count. */
	get size(): number {
		return this.cache.size;
	}
}
