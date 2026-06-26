/// <reference types="bun" />
import { expect, mock, test } from "bun:test";
import { SseWriter } from "./sse.ts";

/**
 * Regression guard: `SseWriter`'s underlying `ReadableStream.cancel`
 * is the only path from "client closed the tab" to `store.abort(id)`. If it
 * stops firing `onClose`, in-flight prompts run to completion and waste LLM
 * tokens.
 *
 * The SSE framing produced by `write()` is already covered end-to-end by
 * `pipe-agent-stream.test.ts`; this file isolates the disconnect callback.
 */

test("SseWriter fires `onClose` when the client cancels the response body (abort path)", async () => {
	const onClose = mock(() => {});
	const writer = new SseWriter(onClose);

	await writer.response.body?.cancel();

	expect(onClose).toHaveBeenCalledTimes(1);
});
