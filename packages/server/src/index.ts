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
import { createLogger, dispose, type Logger } from "@pixies/core/logging";
import { getPostHogLogsSink } from "@pixies/core/logging/posthog-logs-sink";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { Value } from "typebox/value";
import path from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { ConversationStore } from "./conversations.ts";
import { translateAgentEvent } from "./events.ts";
import { SseWriter } from "./sse.ts";
import { IpRateLimiter, checkRateLimit, getClientIp } from "./rate-limit.ts";
import {
	captureAnalytics,
	createPostHogAnalyticsClient,
	type PostHogAnalyticsClient,
} from "./posthog.ts";

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

function registerGracefulShutdown(handlers: Array<() => void | Promise<void>>): void {
	if (gracefulShutdownRegistered) return;
	gracefulShutdownRegistered = true;
	// Await every hook (including the analytics + LogTape flushes) before
	// exiting, so in-flight events/records drain on SIGTERM/SIGINT. Any
	// rejecting hook is absorbed by allSettled — no hook can block the exit.
	// `cleaningUp` guards a second signal arriving mid-flush: without it,
	// SIGTERM then SIGINT would re-enter and run every hook twice (double
	// PostHog flush, double server.stop).
	let cleaningUp = false;
	const cleanup = () => {
		if (cleaningUp) return;
		cleaningUp = true;
		void Promise.allSettled(handlers.map((h) => h())).finally(() => process.exit(0));
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
	/** Injection seam for tests; defaults to a real client when `config.posthogApiKey` is set. */
	posthog?: PostHogAnalyticsClient;
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
	posthog?: PostHogAnalyticsClient,
	onOpen?: (writer: SseWriter) => void,
): Response {
	const startTime = Date.now();
	// Stream lifecycle: `running` → `completed` (wrote `done`) or `aborted`
	// (client went away). Modelled as one state, not separate booleans, so the
	// impossible "completed && aborted" can't be represented.
	let state: "running" | "completed" | "aborted" = "running";
	// First user-facing output timestamp. Assistant text SSE events are
	// deliberately suppressed on the wire (see translateAgentEvent), so the
	// earliest sign of life is the first `tool_execution_start` frame — that's
	// what `had_output` reports.
	let firstOutputAt: number | undefined;
	// TTFT: ms from stream start to the LLM's first user-facing TEXT token. The
	// raw agent event is seen in the loop BEFORE translation, so this is
	// measurable even though assistant text is suppressed on the wire. `thinking_*`
	// variants are excluded (internal reasoning), but their elapsed time is still
	// included since TTFT is measured from `startTime`.
	let firstTokenMs: number | undefined;
	// This `onClose` is the ONLY server-side path from "client went away" to
	// `store.abort` (eviction/sweep/delete call `store.abort` directly, not
	// through here). So the disconnect capture MUST live in this lambda. It only
	// fires while `running` (a cancel after completion is a late close, not a
	// disconnect). The server can't tell a user Stop from a passive disconnect
	// (both cancel the stream), so this fires for both; the client `user_stop`
	// event is the active-rejection subset on a deliberately-unlinked distinctId.
	const writer = new SseWriter(() => {
		if (state === "running") {
			state = "aborted";
			captureAnalytics(posthog, {
				distinctId: abortId,
				name: "agent stream disconnect",
				properties: {
					elapsed_ms: Date.now() - startTime,
					had_output: firstOutputAt !== undefined,
				},
			});
		}
		store.abort(abortId);
	});
	if (onOpen) onOpen(writer);

	void (async () => {
		try {
			for await (const event of result.stream) {
				// Measure TTFT on the RAW event, before wire suppression drops
				// assistant text. Fires mid-stream so even streams that are LATER
				// aborted still contribute a TTFT measurement — measuring only at
				// `done` would re-create the survivor-bias this is about.
				if (
					firstTokenMs === undefined &&
					event.type === "message_update" &&
					event.assistantMessageEvent.type === "text_delta"
				) {
					firstTokenMs = Date.now() - startTime;
					captureAnalytics(posthog, {
						distinctId: abortId,
						name: "agent stream first token",
						properties: { ttft_ms: firstTokenMs },
					});
				}
				for (const sse of translateAgentEvent(event)) {
					// Text is suppressed on the wire, so the first tool-execution
					// event is the first user-facing output.
					if (firstOutputAt === undefined && sse.event === "tool_execution_start") {
						firstOutputAt = Date.now();
					}
					writer.write(sse.event, sse.data);
				}
			}
			const durationMs = Date.now() - startTime;
			// Byte-identical `done` frame (durationMs key/value).
			writer.write("done", { durationMs });
			// Only count genuinely-completed streams: a client abort cancels the
			// response body, after which `writer.write` is a silent no-op
			// (`SseWriter.controller` is undefined, so `controller?.enqueue` does
			// nothing and does NOT throw), so execution still reaches here — the
			// `state === "running"` guard excludes aborted streams (state was set
			// to "aborted" in the onClose lambda).
			if (state === "running") {
				captureAnalytics(posthog, {
					distinctId: abortId,
					name: "agent stream done",
					properties: {
						duration_ms: durationMs,
						...(firstTokenMs !== undefined ? { ttft_ms: firstTokenMs } : {}),
					},
				});
			}
		} catch (err) {
			const loggedErr = err instanceof Error ? err : new Error(String(err));
			logger.error("agent stream error", { conversationId: abortId, err: loggedErr });
			const tag = isTaggedError(err) ? err._tag : undefined;
			// Privacy: capture the error TAG ONLY — never err.message or the Error object.
			// Overpass/Nominatim errors embed OSM HTTP bodies and the searched place name
			// in .message. Subject to change if we later add a sanitised message.
			captureAnalytics(posthog, {
				distinctId: abortId,
				name: "agent stream error",
				properties: tag !== undefined ? { error_tag: tag } : {},
			});
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
			if (state === "running") state = "completed";
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

/**
 * Capture a `rate limit exceeded` event against the client IP resolved once at
 * the handler boundary. Distinct id is the IP, deliberately left unlinked to
 * the browser's anonymous id.
 */
function captureRateLimitDenied(
	posthog: PostHogAnalyticsClient | undefined,
	ip: string | null,
	path: string,
): void {
	captureAnalytics(posthog, {
		distinctId: ip ?? "unknown",
		name: "rate limit exceeded",
		properties: { path },
	});
}

/**
 * Capture a `conversation budget exceeded` event when the prompt was rejected
 * for that reason; no-op for the other {@link StreamPromptError} variants.
 * Exhaustive `matchError` forces a deliberate decision if a new variant lands.
 */
function captureBudgetExceeded(
	posthog: PostHogAnalyticsClient | undefined,
	id: string,
	err: StreamPromptError,
): void {
	matchError(err, {
		BudgetExceeded: (e) =>
			captureAnalytics(posthog, {
				distinctId: id,
				name: "conversation budget exceeded",
				properties: { tokens_used: e.used, token_budget: e.budget },
			}),
		ConversationNotFound: () => {},
		PromptConflict: () => {},
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
		apiKey: config.apiKey ? "set" : "unset",
		posthogApiKey: config.posthogApiKey ? "set" : "unset",
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
	// Server-side PostHog Logs, env-gated via the TypeBox config (off when
	// PIXIES_POSTHOG_API_KEY is unset). Distinct from the VITE_POSTHOG_* browser
	// vars: this is the server secret.
	const posthogSink = config.posthogApiKey
		? getPostHogLogsSink({
				endpoint: `${config.posthogHost}/i/v1/logs`,
				token: config.posthogApiKey,
			})
		: undefined;
	const logger = opts.logger ?? createLogger({ posthogSink });
	registerGlobalHandlers(logger);
	// Off-switch: no `PIXIES_POSTHOG_API_KEY` → no client → no analytics network.
	// Injectable via `opts.posthog` so tests can pass a spy.
	const posthog =
		opts.posthog ??
		(config.posthogApiKey
			? createPostHogAnalyticsClient({ apiKey: config.posthogApiKey, host: config.posthogHost })
			: undefined);
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
					const ip = getClientIp(req, server, rateLimiter.trustProxy, rateLimiter.trustedProxyHops);
					const denied = checkRateLimit(ip, rateLimiter);
					if (denied) {
						captureRateLimitDenied(posthog, ip, "/conversations");
						return denied;
					}
					const parsed = await readMessage(req);
					if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
					const id = store.create();
					server.timeout(req, 0);
					const result = await store.streamPrompt(id, parsed.message);
					if (Result.isError(result)) {
						captureBudgetExceeded(posthog, id, result.error);
						return rejectStream(result.error);
					}
					captureAnalytics(posthog, {
						distinctId: id,
						name: "conversation started",
						properties: { message_length: parsed.message.length },
					});
					return pipeAgentStream(store, result.value, id, logger, posthog, (w) =>
						w.write("conversation_created", { id }),
					);
				}),
			},
			"/conversations/:id/messages": {
				POST: withRequestLogging(logger, async (req, server) => {
					const ip = getClientIp(req, server, rateLimiter.trustProxy, rateLimiter.trustedProxyHops);
					const denied = checkRateLimit(ip, rateLimiter);
					if (denied) {
						captureRateLimitDenied(posthog, ip, "/conversations/:id/messages");
						return denied;
					}
					const id = req.params.id;
					const parsed = await readMessage(req);
					if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
					server.timeout(req, 0);
					const result = await store.streamPrompt(id, parsed.message);
					if (Result.isError(result)) {
						captureBudgetExceeded(posthog, id, result.error);
						return rejectStream(result.error);
					}
					captureAnalytics(posthog, {
						distinctId: id,
						name: "message sent",
						properties: { message_length: parsed.message.length },
					});
					return pipeAgentStream(store, result.value, id, logger, posthog);
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
					if (ok) captureAnalytics(posthog, { distinctId: id, name: "conversation deleted" });
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

	registerGracefulShutdown([
		() => store.stop(),
		() => rateLimiter.stop(),
		() => server.stop(true),
		// Drain the PostHog event queue before exit (best-effort, awaited).
		() => (posthog ? posthog.shutdown() : undefined),
		// Best-effort flush of the LogTape/OTel log sink; swallow errors.
		() => dispose().catch(() => {}),
	]);

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
