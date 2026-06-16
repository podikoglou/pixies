import {
	createAgent,
	readConfigFromEnv,
	toClientTranscriptMessage,
	type ResolvedPixiesConfig,
} from "@pixies/core";
import { createDb } from "@pixies/core/db";
import { createLogger, type Logger } from "@pixies/core/logging";
import { Type } from "typebox";
import { Value } from "typebox/value";
import path from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { ConversationStore, type StreamPromptResult } from "./conversations.ts";
import { translateAgentEvent } from "./events.ts";
import { SseWriter } from "./sse.ts";
import { IpRateLimiter, checkRateLimit } from "./rate-limit.ts";

const WEB_DIST = process.env.PIXIES_WEB_DIST ?? path.resolve(import.meta.dir, "../../web/dist");

let globalHandlersRegistered = false;

export function registerGlobalHandlers(logger: Logger): void {
	if (globalHandlersRegistered) return;
	globalHandlersRegistered = true;
	process.on("unhandledRejection", (reason) => {
		logger.fatal(
			{ err: reason instanceof Error ? reason : new Error(String(reason)) },
			"unhandled rejection",
		);
	});
	process.on("uncaughtException", (err) => {
		logger.error(
			{ err: err instanceof Error ? err : new Error(String(err)) },
			"uncaught exception",
		);
	});
}

export interface StartServerOptions {
	hostname?: string;
	port?: number;
	config?: ResolvedPixiesConfig;
	logger?: Logger;
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
export function pipeAgentStream(
	store: ConversationStore,
	result: Extract<StreamPromptResult, { ok: true }>,
	abortId: string,
	logger: Logger,
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
			logger.error(
				{ conversationId: abortId, err: err instanceof Error ? err : new Error(String(err)) },
				"agent stream error",
			);
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

// Bun augments route handler Request objects with `params`. Use a permissive
// input type so the wrapper works for both plain and parametric routes.
type RouteHandler = (req: any, server: Bun.Server<undefined>) => Response | Promise<Response>;

export function withRequestLogging(
	logger: Logger,
	handler: RouteHandler,
): (req: any, server: Bun.Server<undefined>) => Promise<Response> {
	return async (req, server) => {
		const start = Date.now();
		const res = await handler(req, server);
		logger.info(
			{
				method: req.method,
				path: new URL(req.url).pathname,
				statusCode: res.status,
				durationMs: Date.now() - start,
			},
			"request",
		);
		return res;
	};
}

export function logResolvedConfig(logger: Logger, config: ResolvedPixiesConfig): void {
	logger.info(
		{
			host: config.host,
			port: config.port,
			model: config.model,
			thinkingLevel: config.thinkingLevel,
			dbFile: config.dbFile,
			cacheSize: config.cacheSize,
			httpRateLimit: config.httpRateLimit,
			httpRateLimitWindowMs: config.httpRateLimitWindowMs,
			trustProxy: config.trustProxy,
			discordWebhookUrl: config.discordWebhookUrl ? "set" : "unset",
			apiKey: config.apiKey ? "set" : "unset",
			contactEmail: config.contactEmail ?? "unset",
			overpassUrl: config.overpassUrl,
			nominatimUrl: config.nominatimUrl,
			userAgent: config.userAgent,
			nominatimConcurrency: config.nominatimConcurrency,
			nominatimIntervalCap: config.nominatimIntervalCap,
			nominatimIntervalMs: config.nominatimIntervalMs,
			overpassConcurrency: config.overpassConcurrency,
			overpassIntervalCap: config.overpassIntervalCap,
			overpassIntervalMs: config.overpassIntervalMs,
		},
		"pixies server configuration",
	);
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
	const logger = opts.logger ?? createLogger({ discordWebhookUrl: config.discordWebhookUrl });
	registerGlobalHandlers(logger);
	logResolvedConfig(logger, config);
	const store = new ConversationStore(config, db, createAgent, logger);
	const rateLimiter = new IpRateLimiter({
		maxRequests: config.httpRateLimit,
		windowMs: config.httpRateLimitWindowMs,
		trustProxy: config.trustProxy,
		logger,
	});
	const hostname = opts.hostname ?? config.host;
	const port = opts.port ?? config.port;

	const server = Bun.serve({
		hostname,
		port,
		routes: {
			"/health": withRequestLogging(logger, () =>
				Response.json({ status: "ok", conversations: store.size() }),
			),
			"/conversations": {
				POST: withRequestLogging(logger, async (req, server) => {
					const denied = checkRateLimit(req, server, rateLimiter);
					if (denied) return denied;
					const parsed = await readMessage(req);
					if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
					const id = store.create();
					server.timeout(req, 0);
					const result = await store.streamPrompt(id, parsed.message);
					if (!result.ok) return rejectStream(result);
					return pipeAgentStream(store, result, id, logger, (w) =>
						w.write("conversation_created", { id }),
					);
				}),
			},
			"/conversations/:id/messages": {
				POST: withRequestLogging(logger, async (req, server) => {
					const denied = checkRateLimit(req, server, rateLimiter);
					if (denied) return denied;
					const id = req.params.id;
					const parsed = await readMessage(req);
					if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
					server.timeout(req, 0);
					const result = await store.streamPrompt(id, parsed.message);
					if (!result.ok) return rejectStream(result);
					return pipeAgentStream(store, result, id, logger);
				}),
			},
			"/conversations/:id": {
				GET: withRequestLogging(logger, async (req) => {
					const id = req.params.id;
					const conv = await store.get(id);
					if (!conv)
						return Response.json({ error: `conversation not found: ${id}` }, { status: 404 });
					const messages = conv.agent.state.messages.map(toClientTranscriptMessage);
					return Response.json({ id, messages });
				}),
				DELETE: withRequestLogging(logger, (req) => {
					const id = req.params.id;
					const ok = store.delete(id);
					return ok
						? new Response(null, { status: 204 })
						: Response.json({ error: `conversation not found: ${id}` }, { status: 404 });
				}),
			},
		},
		fetch: withRequestLogging(logger, (req) => {
			const url = new URL(req.url);
			const requested = url.pathname === "/" ? "/index.html" : url.pathname;
			const file = Bun.file(path.join(WEB_DIST, requested));
			if (file.size > 0) return new Response(file);
			const indexHtml = Bun.file(path.join(WEB_DIST, "index.html"));
			if (indexHtml.size > 0) return new Response(indexHtml);
			return Response.json({ error: "not found" }, { status: 404 });
		}),
	});

	const url = `http://${hostname}:${port}`;
	logger.info({ url }, "pixies server listening");
	opts.onReady?.(url);
	return server;
}

if (import.meta.main) {
	startServer();
}
