/// <reference types="bun" />
import { test, expect } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { countTranscriptTokens, budgetExceeded } from "./token-budget.ts";

/**
 * Build a LIVE-style assistant message with required `usage.totalTokens`. The
 * `as unknown as AgentMessage` cast mirrors `conversations.test.ts`'s FakeAgent
 * so we don't have to fabricate every pi-ai metadata field; `totalTokens` is
 * the only field the budget module reads.
 */
function assistant(totalTokens: number): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "x" }],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	} as unknown as AgentMessage;
}

/** Assistant message written by an older binary — persisted with no `usage`. */
function assistantMissingUsage(): AgentMessage {
	// Intentionally omits `usage`; rehydrated rows may look like this (ADR-0008).
	return { role: "assistant", content: [{ type: "text", text: "x" }] } as unknown as AgentMessage;
}

/** A user message (no usage — always skipped by the counter). */
function user(): AgentMessage {
	return { role: "user", content: "hi", timestamp: 1 } as unknown as AgentMessage;
}

// --- countTranscriptTokens ---

test("countTranscriptTokens: empty transcript → 0 total, 0 missingUsage", () => {
	expect(countTranscriptTokens([])).toEqual({ total: 0, missingUsage: 0 });
});

test("countTranscriptTokens: a single assistant message counts its totalTokens", () => {
	expect(countTranscriptTokens([assistant(7)])).toEqual({ total: 7, missingUsage: 0 });
});

test("countTranscriptTokens: multiple assistant messages sum their totals", () => {
	expect(countTranscriptTokens([assistant(3), assistant(5), assistant(2)])).toEqual({
		total: 10,
		missingUsage: 0,
	});
});

test("countTranscriptTokens: non-assistant messages are ignored", () => {
	const msgs: AgentMessage[] = [user(), user()];
	expect(countTranscriptTokens(msgs)).toEqual({ total: 0, missingUsage: 0 });
});

test("countTranscriptTokens: a mix of user + assistant counts only assistants", () => {
	expect(countTranscriptTokens([user(), assistant(4), user(), assistant(6)])).toEqual({
		total: 10,
		missingUsage: 0,
	});
});

test("countTranscriptTokens: rehydrated assistant with no usage counts as 0 and flags missingUsage", () => {
	// The previously-silent-and-unreachable case (ADR-0008): a persisted row
	// lacking `usage` undercounts the budget. The count now signals it.
	expect(countTranscriptTokens([assistantMissingUsage()])).toEqual({
		total: 0,
		missingUsage: 1,
	});
});

test("countTranscriptTokens: missing-usage messages mix with counted ones", () => {
	expect(countTranscriptTokens([assistant(9), assistantMissingUsage(), assistant(1)])).toEqual({
		total: 10,
		missingUsage: 1,
	});
});

// --- budgetExceeded ---

test("budgetExceeded: used === budget → exceeded", () => {
	const err = budgetExceeded(5, 5);
	expect(err).toBeInstanceOf(Error);
	expect(err?.used).toBe(5);
	expect(err?.budget).toBe(5);
});

test("budgetExceeded: used === budget - 1 → within budget", () => {
	expect(budgetExceeded(4, 5)).toBeUndefined();
});

test("budgetExceeded: used well over budget → exceeded", () => {
	expect(budgetExceeded(100, 5)).toBeDefined();
});

test("budgetExceeded: budget === 0 (unlimited) → never exceeded", () => {
	expect(budgetExceeded(0, 0)).toBeUndefined();
	expect(budgetExceeded(1_000_000, 0)).toBeUndefined();
});

test("budgetExceeded: used === 0, positive budget → within budget", () => {
	expect(budgetExceeded(0, 5)).toBeUndefined();
});

test("budgetExceeded: negative budget is treated as unlimited", () => {
	// Defensive — config min is 0, but a malformed value must not block.
	expect(budgetExceeded(1_000_000, -1)).toBeUndefined();
});
