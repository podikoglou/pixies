import { Value } from "typebox/value";
import { SSE_EVENT_DATA_SCHEMAS } from "@pixies/core";
import type { SSEEvent, SSEEventName } from "@pixies/core";

export class ApiError extends Error {
	readonly status: number;
	readonly body: unknown;
	constructor(status: number, message: string, body: unknown) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		this.body = body;
	}
}

function extractErrorMessage(body: unknown): string | undefined {
	if (body && typeof body === "object" && "error" in body) {
		const err = (body as { error?: unknown }).error;
		if (typeof err === "string") return err;
	}
	return undefined;
}

export async function buildApiError(res: Response): Promise<ApiError> {
	let body: unknown;
	try {
		body = await res.json();
	} catch {
		body = null;
	}
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

	let data: unknown;
	try {
		data = JSON.parse(dataLine);
	} catch {
		return null;
	}

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
