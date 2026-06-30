import {
	createAgent,
	readConfigFromEnv,
	Result,
	matchError,
	isToolProgress,
	InvalidJsonError,
	ValidationError,
	type ResolvedPixiesConfig,
	type StreamPromptError,
} from "@pixies/core";
import { toClientTranscriptMessage } from "@pixies/protocol";
import { createDb } from "@pixies/core/db";
import { createLogger, dispose, type Logger } from "@pixies/core/logging";
import { getPostHogLogsSink } from "@pixies/core/logging/posthog-logs-sink";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { BunRequest } from "bun";
import { Type } from "typebox";
import { Value } from "typebox/value";
import path from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { captureServerEvent } from "./analytics-events.ts";
import { ConversationStore } from "./conversations.ts";
import { readServerConfigFromEnv, type ServerConfig } from "./config.ts";
import { translateAgentEvent } from "./events.ts";
import { createPostHogAnalyticsClient, type PostHogAnalyticsClient } from "./posthog.ts";
import { checkRateLimit, getClientIp, IpRateLimiter } from "./rate-limit.ts";
import { SseWriter } from "./sse.ts";
import { StreamInstrumentation } from "./stream-instrumentation.ts";

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
	/** Injection seam for the server-only boot paths (web dist, migrations folder). */
	serverConfig?: ServerConfig;
	logger?: Logger;
	/** Injection seam for tests; defaults to a real client when `config.posthogApiKey` is set. */
	posthog?: PostHogAnalyticsClient;
	onReady?: (url: string) => void;
}

const MessageBodySchema = Type.Object({
	message: Type.String({ minLength: 1 }),
});

/**
 * Parse and validate the request body's `message` field.
 *
 * JSON-parse failures map to {@link InvalidJsonError}; schema failures map to
 * {@link ValidationError}. Both flow through `Result` rather than a hand-rolled
 * union, so the caller exhaustively matches via {@link rejectMessageError}.
 */
async function readMessage(
	req: Request,
): Promise<Result<{ message: string }, InvalidJsonError | ValidationError>> {
	const json = await Result.tryPromise(() => req.json());
	if (Result.isError(json)) return Result.err(new InvalidJsonError({ message: "invalid JSON" }));
	const body = json.value;
	if (!Value.Check(MessageBodySchema, body))
		return Result.err(new ValidationError({ message: "missing required field: message" }));
	return Result.ok({ message: body.message });
}

/** Map a {@link readMessage} error to its HTTP response (exhaustive). */
function rejectMessageError(err: InvalidJsonError | ValidationError): Response {
	return matchError(err, {
		InvalidJson: () => Response.json({ error: "invalid JSON" }, { status: 400 }),
		Validation: () => Response.json({ error: "missing required field: message" }, { status: 400 }),
	});
}

/**
 * Pipe a store-owned agent stream into an SSE response.
 *
 * The store owns `inFlight`, the `agent.prompt()` call, and the `.finally()`
 * that clears state. This function owns ONLY the HTTP concerns: building the
 * `SseWriter`, translating agent events to SSE, writing the terminal
 * `done`/`error` wire frame, and forwarding client disconnect to
 * `ConversationStore.abort`.
 *
 * Every NON-HTTP concern — TTFT timing, the first-output stamp, the
 * `running → completed | aborted` lifecycle machine, and ALL analytics
 * captures (first token / done / disconnect / error) — lives in the
 * {@link StreamInstrumentation} seam, constructed below and tapped at each
 * lifecycle point.
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
	// Instrumentation seam owns all timing + analytics for this response.
	const instr = new StreamInstrumentation(abortId, posthog, logger);
	// The `onClose` lambda is the ONLY server-side path from "client went away"
	// to a disconnect capture (eviction/sweep/delete call `store.abort`
	// directly, not through here). `instr.disconnect()` no-ops once the stream
	// has completed, so a late close after `done` can't double-count.
	const writer = new SseWriter(() => {
		instr.disconnect();
		store.abort(abortId);
	});
	if (onOpen) onOpen(writer);

	void (async () => {
		try {
			for await (const event of result.stream) {
				// Per-turn analytics. `turn_start` anchors the turn's
				// `duration_ms` (the agent loop omits it for the first turn, so
				// the recorder falls back to stream start). `turn_end` carries
				// the assistant message (stopReason + usage) + the turn's tool
				// results, which `recordTurnEnd` reduces to coarse metadata —
				// tool ids, counts, durations, soft-failure flags. No tool args.
				if (event.type === "turn_start") instr.recordTurnStart();
				if (event.type === "turn_end") instr.recordTurnEnd(event.message, event.toolResults);
				// Per-tool analytics. `tool_execution_start` stamps the
				// duration anchor; `tool_execution_update` progress tracks the
				// rate-limiter queue wait (queued → running); `tool_execution_end`
				// captures the `tool call` event — outcome, latency, queue-wait,
				// result count. Only `result.details` is read (never content/args).
				if (event.type === "tool_execution_start") instr.recordToolStart(event.toolCallId);
				if (event.type === "tool_execution_update") {
					const progress = event.partialResult?.details;
					if (isToolProgress(progress)) instr.recordToolProgress(event.toolCallId, progress);
				}
				if (event.type === "tool_execution_end")
					instr.recordToolEnd(event.toolCallId, event.toolName, event.result, event.isError);
				// Measure TTFT on the RAW event, before wire suppression drops
				// assistant text. Fires mid-stream so even streams that are LATER
				// aborted still contribute a TTFT measurement — measuring only at
				// `done` would re-create the survivor-bias this is about. The
				// text_delta discrimination stays in this loop; the seam just
				// records + captures once.
				if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
					instr.recordFirstTextToken();
				}
				for (const sse of translateAgentEvent(event)) {
					// Text is suppressed on the wire, so the first tool-execution
					// event is the first user-facing output.
					if (sse.event === "tool_execution_start") instr.recordFirstOutput();
					writer.write(sse.event, sse.data);
				}
			}
			// `complete` captures `agent stream done` (guarded to running),
			// transitions to completed, and returns the SAME duration the
			// byte-identical `done` wire frame carries — computed once, not
			// twice. Undefined means the stream was aborted (the response body
			// is already torn down, so no `done` frame is wanted).
			const durationMs = instr.complete();
			if (durationMs !== undefined) writer.write("done", { durationMs });
		} catch (err) {
			// `fail` logs, captures the error TAG ONLY (never err.message), and
			// returns the wire-frame ingredients for the byte-identical `error`.
			const { tag, message, details } = instr.fail(err);
			writer.write("error", {
				message,
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
	captureServerEvent(posthog, ip ?? "unknown", "rate limit exceeded", { path });
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
			captureServerEvent(posthog, id, "conversation budget exceeded", {
				tokens_used: e.used,
				token_budget: e.budget,
			}),
		ConversationNotFound: () => {},
		PromptConflict: () => {},
	});
}

function withRequestLogging<T extends string = string>(
	logger: Logger,
	handler: (req: BunRequest<T>, server: Bun.Server<undefined>) => Response | Promise<Response>,
): (req: BunRequest<T>, server: Bun.Server<undefined>) => Promise<Response> {
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

function logResolvedConfig(
	logger: Logger,
	config: ResolvedPixiesConfig,
	serverConfig: ServerConfig,
): void {
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
		nominatimTimeoutMs: config.nominatimTimeoutMs,
		overpassConcurrency: config.overpassConcurrency,
		overpassIntervalCap: config.overpassIntervalCap,
		overpassIntervalMs: config.overpassIntervalMs,
		overpassTimeoutMs: config.overpassTimeoutMs,
		webDist: serverConfig.webDist,
		migrationsFolder: serverConfig.migrationsFolder,
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
	const serverConfig = opts.serverConfig ?? readServerConfigFromEnv();
	const db = createDb(config.dbFile);
	migrate(db, { migrationsFolder: serverConfig.migrationsFolder });
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
	logResolvedConfig(logger, config, serverConfig);
	const store = new ConversationStore(config, db, createAgent, logger);
	const rateLimiter = new IpRateLimiter({
		maxRequests: config.httpRateLimit,
		windowMs: config.httpRateLimitWindowMs,
		trustProxy: config.trustProxy,
		trustedProxyHops: config.trustedProxyHops,
		logger,
	});

	interface StreamMessageOpts {
		rateLimitPath: string;
		analyticsEvent: "conversation started" | "message sent";
		resolveId: (req: BunRequest) => string;
		onOpen?: (writer: SseWriter, id: string) => void;
	}

	function createStreamMessageHandler(
		opts: StreamMessageOpts,
	): (req: BunRequest, server: Bun.Server<undefined>) => Promise<Response> {
		const { rateLimitPath, analyticsEvent, resolveId, onOpen } = opts;
		return async (req: BunRequest, server: Bun.Server<undefined>) => {
			const ip = getClientIp(req, server, rateLimiter.trustProxy, rateLimiter.trustedProxyHops);
			const denied = checkRateLimit(ip, rateLimiter);
			if (denied) {
				captureRateLimitDenied(posthog, ip, rateLimitPath);
				return denied;
			}
			const parsed = await readMessage(req);
			if (Result.isError(parsed)) return rejectMessageError(parsed.error);
			const id = resolveId(req);
			server.timeout(req, 0);
			const result = await store.streamPrompt(id, parsed.value.message);
			if (Result.isError(result)) {
				captureBudgetExceeded(posthog, id, result.error);
				return rejectStream(result.error);
			}
			captureServerEvent(posthog, id, analyticsEvent, {
				message_length: parsed.value.message.length,
			});
			return pipeAgentStream(
				store,
				result.value,
				id,
				logger,
				posthog,
				onOpen ? (w) => onOpen(w, id) : undefined,
			);
		};
	}

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
				POST: withRequestLogging(
					logger,
					createStreamMessageHandler({
						rateLimitPath: "/conversations",
						analyticsEvent: "conversation started",
						resolveId: () => store.create(),
						onOpen: (w, id) => w.write("conversation_created", { id }),
					}),
				),
			},
			"/conversations/:id/messages": {
				POST: withRequestLogging(
					logger,
					createStreamMessageHandler({
						rateLimitPath: "/conversations/:id/messages",
						analyticsEvent: "message sent",
						resolveId: (req) => req.params.id!,
					}),
				),
			},
			"/conversations/:id": {
				GET: withRequestLogging(logger, async (req) => {
					const id = req.params.id!;
					const conv = await store.get(id);
					if (!conv)
						return Response.json({ error: `conversation not found: ${id}` }, { status: 404 });
					const messages = conv.agent.state.messages
						.filter((m) => m.role !== "assistant")
						.map(toClientTranscriptMessage);
					return Response.json({ id, messages });
				}),
				DELETE: withRequestLogging(logger, (req) => {
					const id = req.params.id!;
					const ok = store.delete(id);
					if (ok) captureServerEvent(posthog, id, "conversation deleted", {});
					return ok
						? new Response(null, { status: 204 })
						: Response.json({ error: `conversation not found: ${id}` }, { status: 404 });
				}),
			},
		},
		fetch: withRequestLogging(logger, (req) => {
			const url = new URL(req.url);
			const requested = url.pathname === "/" ? "/index.html" : url.pathname;
			const file = Bun.file(path.join(serverConfig.webDist, requested));
			if (file.size > 0) return new Response(file);
			const indexHtml = Bun.file(path.join(serverConfig.webDist, "index.html"));
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
