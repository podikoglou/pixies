import {
	createAgent,
	readConfigFromEnv,
	toClientTranscriptMessage,
	Result,
	matchError,
	isTaggedError,
	type ResolvedPixiesConfig,
	type StreamPromptError,
} from "@pixies/core";
import { createDb } from "@pixies/core/db";
import { createLogger, type Logger } from "@pixies/core/logging";
import { getDiscordSink } from "@pixies/core/logging/discord-sink";
import { getPostHogLogsSink } from "@pixies/core/logging/posthog-logs-sink";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { Value } from "typebox/value";
import path from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { ConversationStore } from "./conversations.ts";
import { translateAgentEvent } from "./events.ts";
import { SseWriter } from "./sse.ts";
import { IpRateLimiter, checkRateLimit } from "./rate-limit.ts";

const WEB_DIST = process.env.PIXIES_WEB_DIST ?? path.resolve(import.meta.dir, "../../web/dist");
const MIGRATIONS_FOLDER =
	process.env.PIXIES_MIGRATIONS_FOLDER ?? path.resolve(import.meta.dir, "../../../drizzle");

let globalHandlersRegistered = false;

function registerGlobalHandlers(logger: Logger): void {
	if (globalHandlersRegistered) return;
	globalHandlersRegistered = true;
	process.on("unhandledRejection", (reason) => {
		logger.fatal("unhandled rejection", {
			err: reason instanceof Error ? reason : new Error(String(reason)),
		});
	});
	process.on("uncaughtException", (err) => {
		logger.error("uncaught exception", {
			err: err instanceof Error ? err : new Error(String(err)),
		});
	});
}

let gracefulShutdownRegistered = false;

function registerGracefulShutdown(handlers: Array<() => void>): void {
	if (gracefulShutdownRegistered) return;
	gracefulShutdownRegistered = true;
	const cleanup = () => {
		for (const handler of handlers) handler();
		process.exit(0);
	};
	process.on("SIGTERM", cleanup);
	process.on("SIGINT", cleanup);
}

export interface ServerInstance {
	readonly server: Bun.Server<undefined>;
	stop(): void;
}

export interface StartServerOptions extends Partial<Pick<ResolvedPixiesConfig, "host" | "port">> {
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
	result: { stream: ReadableStream<AgentEvent> },
	abortId: string,
	logger: Logger,
	onOpen?: (writer: SseWriter) => void,
): Response {
	const writer = new SseWriter(() => store.abort(abortId));
	if (onOpen) onOpen(writer);

	const startTime = Date.now();
	void (async () => {
		try {
			for await (const event of result.stream) {
				for (const sse of translateAgentEvent(event)) writer.write(sse.event, sse.data);
			}
			writer.write("done", { durationMs: Date.now() - startTime });
		} catch (err) {
			const loggedErr = err instanceof Error ? err : new Error(String(err));
			logger.error("agent stream error", { conversationId: abortId, err: loggedErr });
			// Forward structured error metadata when the agent rejected with a
			// TaggedError (issue #109). Non-tagged errors emit only `message`,
			// which is byte-identical to the pre-#109 wire format.
			const tag = isTaggedError(err) ? err._tag : undefined;
			// `isTaggedError` narrows to the loose `AnyTaggedError` shape (which
			// omits `toJSON` from its type), but every TaggedError instance
			// carries a safe `toJSON()` serializer at runtime.
			const details = isTaggedError(err)
				? ((err as unknown as { toJSON(): object }).toJSON() as Record<string, unknown>)
				: undefined;
			writer.write("error", {
				message: err instanceof Error ? err.message : String(err),
				...(tag !== undefined ? { errorTag: tag } : {}),
				...(details !== undefined ? { details } : {}),
			});
		} finally {
			writer.close();
		}
	})();

	return writer.response;
}

/** Map a non-ok {@link StreamPromptError} to its HTTP response. */
function rejectStream(err: StreamPromptError): Response {
	return matchError(err, {
		ConversationNotFound: (e) =>
			Response.json({ error: `conversation not found: ${e.id}` }, { status: 404 }),
		PromptConflict: () =>
			Response.json({ error: "conversation already has an in-flight prompt" }, { status: 409 }),
		BudgetExceeded: (e) =>
			Response.json(
				{
					error: `conversation token budget (${e.budget}) exceeded: used ${e.used}`,
					used: e.used,
					budget: e.budget,
				},
				{ status: 403 },
			),
	});
}

// Bun augments route handler Request objects with `params`. Use a permissive
// input type so the wrapper works for both plain and parametric routes.
type RouteHandler = (req: any, server: Bun.Server<undefined>) => Response | Promise<Response>;

function withRequestLogging(
	logger: Logger,
	handler: RouteHandler,
): (req: any, server: Bun.Server<undefined>) => Promise<Response> {
	return async (req, server) => {
		const start = Date.now();
		const res = await handler(req, server);
		logger.info("request", {
			method: req.method,
			path: new URL(req.url).pathname,
			statusCode: res.status,
			durationMs: Date.now() - start,
		});
		return res;
	};
}

function logResolvedConfig(logger: Logger, config: ResolvedPixiesConfig): void {
	logger.info("pixies server configuration", {
		host: config.host,
		port: config.port,
		model: config.model,
		thinkingLevel: config.thinkingLevel,
		dbFile: config.dbFile,
		cacheSize: config.cacheSize,
		httpRateLimit: config.httpRateLimit,
		httpRateLimitWindowMs: config.httpRateLimitWindowMs,
		trustProxy: config.trustProxy,
		trustedProxyHops: config.trustedProxyHops,
		conversationTokenBudget: config.conversationTokenBudget,
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
	});
}

export function startServer(opts: StartServerOptions = {}): ServerInstance {
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
	migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
	const sink = config.discordWebhookUrl
		? getDiscordSink({ url: config.discordWebhookUrl })
		: undefined;
	// Server-side PostHog Logs (off when POSTHOG_API_KEY is unset). These are
	// NOT PIXIES_-prefixed config vars — read directly from the environment.
	// Distinct from the VITE_POSTHOG_* browser vars: this is the server secret.
	const posthogKey = process.env.POSTHOG_API_KEY;
	const posthogHost = process.env.POSTHOG_HOST ?? "https://eu.i.posthog.com";
	const posthogSink = posthogKey
		? getPostHogLogsSink({ endpoint: `${posthogHost}/i/v1/logs`, token: posthogKey })
		: undefined;
	const logger = opts.logger ?? createLogger({ discordSink: sink, posthogSink });
	registerGlobalHandlers(logger);
	logResolvedConfig(logger, config);
	const store = new ConversationStore(config, db, createAgent, logger);
	const rateLimiter = new IpRateLimiter({
		maxRequests: config.httpRateLimit,
		windowMs: config.httpRateLimitWindowMs,
		trustProxy: config.trustProxy,
		trustedProxyHops: config.trustedProxyHops,
		logger,
	});
	const hostname = opts.host ?? config.host;
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
					if (Result.isError(result)) return rejectStream(result.error);
					return pipeAgentStream(store, result.value, id, logger, (w) =>
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
					if (Result.isError(result)) return rejectStream(result.error);
					return pipeAgentStream(store, result.value, id, logger);
				}),
			},
			"/conversations/:id": {
				GET: withRequestLogging(logger, async (req) => {
					const id = req.params.id;
					const conv = await store.get(id);
					if (!conv)
						return Response.json({ error: `conversation not found: ${id}` }, { status: 404 });
					const messages = conv.agent.state.messages
						.filter((m) => m.role !== "assistant")
						.map(toClientTranscriptMessage);
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
	logger.info("pixies server listening", { url });
	opts.onReady?.(url);

	registerGracefulShutdown([() => store.stop(), () => rateLimiter.stop(), () => server.stop(true)]);

	return {
		server,
		stop: () => {
			store.stop();
			rateLimiter.stop();
			server.stop(true);
		},
	};
}

if (import.meta.main) {
	startServer();
}
