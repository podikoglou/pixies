import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { Result } from "@pixies/core";
import { SSE_EVENT_DATA_SCHEMAS } from "@pixies/protocol";
import type { SSEEvent, SSEEventName } from "@pixies/protocol";

export class ApiError extends Error {
	status: number;
	body: unknown;
	constructor(status: number, message: string, body: unknown) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		this.body = body;
	}
}

/**
 * Wire contract for a server error response body carrying a human-readable
 * message. The server emits `Response.json({ error: "..." }, ...)` (see
 * `packages/server/src/index.ts`), so `{ error: string }` is the contracted
 * shape. TypeBox's `Type.Object` default does not reject extra properties, so
 * future fields (e.g. `errorTag`) won't break extraction. Per ADR-0002 this is
 * a wire contract → TypeBox.
 */
const ApiErrorMessageSchema = Type.Object({
	error: Type.String(),
});
type ApiErrorMessage = Static<typeof ApiErrorMessageSchema>;

/**
 * Extract the `error` string from an HTTP error response body, or `undefined`
 * if the body is not the contracted `{ error: string }` shape. Schema-driven so
 * the manual `typeof` / `"error" in body` boilerplate is replaced by a single
 * `Value.Check`.
 */
export function extractErrorMessage(body: unknown): string | undefined {
	if (!Value.Check(ApiErrorMessageSchema, body)) return undefined;
	return (body as ApiErrorMessage).error;
}

export async function buildApiError(res: Response): Promise<ApiError> {
	const bodyResult = await Result.tryPromise(() => res.json());
	const body = Result.isOk(bodyResult) ? bodyResult.value : null;
	const message = extractErrorMessage(body) ?? `request failed with status ${res.status}`;
	return new ApiError(res.status, message, body);
}

export function parseSseFrame(raw: string): SSEEvent | null {
	let eventName: string | null = null;
	let dataLine: string | null = null;
	for (const line of raw.split("\n")) {
		if (line === "") continue;
		if (line.startsWith(":")) continue;
		if (line.startsWith("event:")) {
			eventName = line.slice("event:".length).trim();
		} else if (line.startsWith("data:")) {
			dataLine = line.slice("data:".length).trim();
		}
	}
	if (eventName === null || dataLine === null) return null;

	const dataResult = Result.try(() => JSON.parse(dataLine));
	if (Result.isError(dataResult)) return null;
	const data = dataResult.value;

	const schema = SSE_EVENT_DATA_SCHEMAS[eventName as SSEEventName];
	if (!schema) return null;
	if (!Value.Check(schema, data)) return null;

	return { event: eventName as SSEEventName, data: data as SSEEvent["data"] } as SSEEvent;
}

export async function* streamSSE(
	url: string,
	body: unknown,
	signal?: AbortSignal,
): AsyncGenerator<SSEEvent> {
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal,
	});
	if (!res.ok) throw await buildApiError(res);
	if (!res.body) throw new ApiError(res.status, "response has no body", null);

	const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
	let buf = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += value;
			const frames = buf.split("\n\n");
			buf = frames.pop() ?? "";
			for (const raw of frames) {
				const evt = parseSseFrame(raw);
				if (evt) yield evt;
			}
		}
		if (buf.trim() !== "") {
			const evt = parseSseFrame(buf);
			if (evt) yield evt;
		}
	} finally {
		reader.releaseLock();
	}
}
