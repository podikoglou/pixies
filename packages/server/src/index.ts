import {
	readConfigFromEnv,
	toClientTranscriptMessage,
	type ResolvedPixiesConfig,
} from "@pixies/core";
import { createDb } from "@pixies/core/db";
import { Type } from "typebox";
import { Value } from "typebox/value";
import path from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { ConversationStore, type StreamPromptResult } from "./conversations.ts";
import { translateAgentEvent } from "./events.ts";
import { SseWriter } from "./sse.ts";
import { IpRateLimiter, checkRateLimit } from "./rate-limit.ts";

const WEB_DIST = process.env.PIXIES_WEB_DIST ?? path.resolve(import.meta.dir, "../../web/dist");

export interface StartServerOptions {
	hostname?: string;
	port?: number;
	config?: ResolvedPixiesConfig;
	onReady?: (url: string) => void;
}

type MessageResult = { ok: true; message: string } | { ok: false; status: number; error: string };

const MessageBodySchema = Type.Object({
	message: Type.String({ minLength: 1 }),
});

async function readMessage(req: Request): Promise<MessageResult> {
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return { ok: false, status: 400, error: "invalid JSON" };
	}
	if (!Value.Check(MessageBodySchema, body))
		return { ok: false, status: 400, error: "missing required field: message" };
	return { ok: true, message: body.message };
}

/**
 * Pipe a store-owned agent stream into an SSE response.
 *
 * The store owns `inFlight`, the `agent.prompt()` call, and the `.finally()`
 * that clears state. This function owns only the HTTP concerns: building the
 * `SseWriter`, translating agent events to SSE, writing the terminal
 * `done`/`error` event, and forwarding client disconnect to
 * `ConversationStore.abort`.
 *
 * @param onOpen   Optional preamble writer (e.g. `conversation_created`).
 * @param abortId  Conversation id to abort on client disconnect.
 */
function pipeAgentStream(
	store: ConversationStore,
	result: Extract<StreamPromptResult, { ok: true }>,
	abortId: string,
	onOpen?: (writer: SseWriter) => void,
): Response {
	const writer = new SseWriter(() => store.abort(abortId));
	if (onOpen) onOpen(writer);

	void (async () => {
		try {
			for await (const event of result.stream) {
				for (const sse of translateAgentEvent(event)) writer.write(sse.event, sse.data);
			}
			writer.write("done", {});
		} catch (err) {
			writer.write("error", { message: err instanceof Error ? err.message : String(err) });
		} finally {
			writer.close();
		}
	})();

	return writer.response;
}

/** Map a non-ok {@link StreamPromptResult} to its HTTP response. */
function rejectStream(result: Extract<StreamPromptResult, { ok: false }>): Response {
	if (result.reason === "conflict")
		return Response.json(
			{ error: "conversation already has an in-flight prompt" },
			{ status: 409 },
		);
	return Response.json({ error: "conversation not found" }, { status: 404 });
}

export function startServer(opts: StartServerOptions = {}): Bun.Server<undefined> {
	let config: ResolvedPixiesConfig;
	try {
		config = opts.config ?? readConfigFromEnv();
	} catch (e) {
		if (e instanceof Error) {
			throw new Error(`Server configuration error: ${e.message}`);
		}
		throw e;
	}
	const db = createDb(config.dbFile);
	migrate(db, { migrationsFolder: "./drizzle" });
	const store = new ConversationStore(config, db);
	// In-process per-IP limiter for the two LLM-cost POST endpoints. Works in
	// dev and prod; Caddy-side limiting remains an optional future
	// defense-in-depth (stock Caddy has no rate-limit plugin). See #91.
	const rateLimiter = new IpRateLimiter({
		maxRequests: config.httpRateLimit,
		windowMs: config.httpRateLimitWindowMs,
		trustProxy: config.trustProxy,
	});
	const hostname = opts.hostname ?? config.host;
	const port = opts.port ?? config.port;

	const server = Bun.serve({
		hostname,
		port,
		routes: {
			"/health": () => Response.json({ status: "ok", conversations: store.size() }),
			"/conversations": {
				POST: async (req, server) => {
					const denied = checkRateLimit(req, server, rateLimiter);
					if (denied) return denied;
					const parsed = await readMessage(req);
					if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
					const id = store.create();
					server.timeout(req, 0);
					// Fresh conversation: not_found/conflict are impossible, but the
					// type still asks us to handle them.
					const result = await store.streamPrompt(id, parsed.message);
					if (!result.ok) return rejectStream(result);
					return pipeAgentStream(store, result, id, (w) => w.write("conversation_created", { id }));
				},
			},
			"/conversations/:id/messages": {
				POST: async (req, server) => {
					const denied = checkRateLimit(req, server, rateLimiter);
					if (denied) return denied;
					const id = req.params.id;
					const parsed = await readMessage(req);
					if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
					server.timeout(req, 0);
					const result = await store.streamPrompt(id, parsed.message);
					if (!result.ok) return rejectStream(result);
					return pipeAgentStream(store, result, id);
				},
			},
			"/conversations/:id": {
				GET: async (req) => {
					const id = req.params.id;
					const conv = await store.get(id);
					if (!conv)
						return Response.json({ error: `conversation not found: ${id}` }, { status: 404 });
					const messages = conv.agent.state.messages.map(toClientTranscriptMessage);
					return Response.json({ id, messages });
				},
				DELETE: (req) => {
					const id = req.params.id;
					const ok = store.delete(id);
					return ok
						? new Response(null, { status: 204 })
						: Response.json({ error: `conversation not found: ${id}` }, { status: 404 });
				},
			},
		},
		fetch: (req) => {
			const url = new URL(req.url);
			const requested = url.pathname === "/" ? "/index.html" : url.pathname;
			const file = Bun.file(path.join(WEB_DIST, requested));
			if (file.size > 0) return new Response(file);
			const indexHtml = Bun.file(path.join(WEB_DIST, "index.html"));
			if (indexHtml.size > 0) return new Response(indexHtml);
			return Response.json({ error: "not found" }, { status: 404 });
		},
	});

	opts.onReady?.(`http://${hostname}:${port}`);
	return server;
}

if (import.meta.main) {
	startServer({ onReady: (url) => console.log(`pixies server listening on ${url}`) });
}
