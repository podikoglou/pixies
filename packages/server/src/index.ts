import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { readConfigFromEnv, type ResolvedPixiesConfig } from "@pixies/core";
import path from "node:path";
import { ConversationStore, type Conversation } from "./conversations.ts";
import { translateAgentEvent } from "./events.ts";
import { SseWriter } from "./sse.ts";

const WEB_DIST = process.env.PIXIES_WEB_DIST ?? path.resolve(import.meta.dir, "../../web/dist");

export interface StartServerOptions {
	hostname?: string;
	port?: number;
	config?: ResolvedPixiesConfig;
	onReady?: (url: string) => void;
}

type MessageResult = { ok: true; message: string } | { ok: false; status: number; error: string };

async function readMessage(req: Request): Promise<MessageResult> {
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return { ok: false, status: 400, error: "invalid JSON" };
	}
	if (typeof body !== "object" || body === null)
		return { ok: false, status: 400, error: "missing required field: message" };
	const message = (body as { message?: unknown }).message;
	if (typeof message !== "string" || !message.trim())
		return { ok: false, status: 400, error: "missing required field: message" };
	return { ok: true, message };
}

function streamPrompt(conv: Conversation, message: string, conversationId?: string): Response {
	const writer = new SseWriter(() => conv.agent.abort());
	if (conversationId) writer.write("conversation_created", { id: conversationId });

	const unsubscribe = conv.agent.subscribe((event: AgentEvent) => {
		for (const sse of translateAgentEvent(event)) writer.write(sse.event, sse.data);
	});
	conv.inFlight = true;
	conv.agent
		.prompt(message)
		.then(
			() => writer.write("done", {}),
			(err) => writer.write("error", { message: err instanceof Error ? err.message : String(err) }),
		)
		.finally(() => {
			unsubscribe();
			conv.inFlight = false;
			writer.close();
		});
	return writer.response;
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
	const store = new ConversationStore(config);
	const hostname = opts.hostname ?? config.host;
	const port = opts.port ?? config.port;

	const server = Bun.serve({
		hostname,
		port,
		routes: {
			"/health": () => Response.json({ status: "ok", conversations: store.size() }),
			"/conversations": {
				POST: async (req, server) => {
					const parsed = await readMessage(req);
					if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
					const conv = store.create();
					server.timeout(req, 0);
					return streamPrompt(conv, parsed.message, conv.id);
				},
			},
			"/conversations/:id/messages": {
				POST: async (req, server) => {
					const id = req.params.id;
					const conv = store.get(id);
					if (!conv)
						return Response.json({ error: `conversation not found: ${id}` }, { status: 404 });
					if (conv.inFlight)
						return Response.json(
							{ error: "conversation already has an in-flight prompt" },
							{ status: 409 },
						);
					const parsed = await readMessage(req);
					if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
					server.timeout(req, 0);
					return streamPrompt(conv, parsed.message);
				},
			},
			"/conversations/:id": {
				GET: (req) => {
					const id = req.params.id;
					const conv = store.get(id);
					if (!conv)
						return Response.json({ error: `conversation not found: ${id}` }, { status: 404 });
					const messages = conv.agent.state.messages;
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
