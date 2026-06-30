// Custom promptfoo provider for the Pixies SSE API.
//
// POSTs a message to /conversations, streams the response, parses the
// tool-execution events, and returns BOTH:
//   - `output`:   a human-readable transcript (what the llm-rubric judge reads)
//   - `metadata`: structured fields (what deterministic `javascript` asserts read
//                 via `context.providerResponse.metadata`)
//
// The Pixies agent emits NO prose answer — every fact reaches the client through
// `tool_execution_end.result.details` (`stdout` + `displays`). So "the response"
// we judge is the parsed tool result, not chat text.

const DEFAULT_BASE_URL = "https://pixies.aleep.lol";
const DEFAULT_TIMEOUT_MS = 120_000;

const SERVICE_BUSY_TAGS = new Set(["OverpassBusy", "NominatimBusy"]);

/**
 * promptfoo calls this with either (prompt, context) or (prompt, options, context)
 * depending on version — accept both.
 *
 * @param {string} prompt  Rendered prompt; with the `{{message}}` template this
 *                         is just the user's message.
 * @param {object} [maybeOptions]
 * @param {object} [maybeContext]
 */
async function callApi(prompt, maybeOptions, maybeContext) {
	const context = maybeContext ?? maybeOptions;
	const options = maybeContext ? maybeOptions : context?.options;
	const config = options?.config ?? {};
	const vars = context?.vars ?? {};

	const baseUrl = String(
		config.baseUrl ?? process.env.PIXIES_EVAL_BASE_URL ?? DEFAULT_BASE_URL,
	).replace(/\/+$/, "");
	const timeoutMs = Number(
		config.timeoutMs ?? process.env.PIXIES_EVAL_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS,
	);

	const message =
		typeof vars.message === "string" && vars.message.length > 0
			? vars.message
			: String(prompt ?? "").trim();

	if (!message) {
		return { output: "ERROR: provider received no message", error: "no message" };
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	let res;
	try {
		res = await fetch(`${baseUrl}/conversations`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "text/event-stream",
			},
			body: JSON.stringify({ message }),
			signal: controller.signal,
		});
	} catch (err) {
		clearTimeout(timer);
		const msg =
			err?.name === "AbortError" ? `timed out after ${timeoutMs}ms` : String(err?.message ?? err);
		return { output: `NETWORK ERROR: ${msg}`, error: msg };
	}

	const contentType = res.headers.get("content-type") ?? "";
	if (!res.ok || !contentType.includes("text/event-stream")) {
		const body = await res.text().catch(() => "");
		clearTimeout(timer);
		return {
			output: `HTTP ${res.status} ${res.statusText} (content-type: ${contentType})\n${body}`,
			error: `http ${res.status}`,
		};
	}

	const { events, fatal } = await readSse(res.body, controller);
	clearTimeout(timer);

	const summary = summarize(message, events, fatal);
	return { output: renderTranscript(summary), metadata: summary };
}

/** Read the SSE stream and parse it into `{event, data}` frames. */
async function readSse(body, controller) {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	const events = [];
	let fatal = null;

	const handle = (frame) => {
		const parsed = parseFrame(frame);
		if (!parsed) return;
		events.push(parsed);
		if (parsed.event === "error") fatal = parsed.data;
	};

	try {
		while (true) {
			const { done, value } = await reader.read().catch((err) => {
				// AbortController timeout surfaces here — treat as fatal, not a crash.
				if (err?.name === "AbortError") return { done: true, value: undefined };
				throw err;
			});
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			let idx;
			while ((idx = buf.indexOf("\n\n")) !== -1) {
				handle(buf.slice(0, idx));
				buf = buf.slice(idx + 2);
			}
		}
		if (buf.trim().length > 0) handle(buf); // trailing frame without final blank line
	} finally {
		try {
			reader.releaseLock();
		} catch {
			/* noop */
		}
		if (!controller.signal.aborted) controller.abort();
	}
	return { events, fatal };
}

/** Parse one SSE frame (`event:` + `data:` lines) into `{event, data}`. */
function parseFrame(frame) {
	let event = "message";
	const dataLines = [];
	for (const rawLine of frame.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		if (line === "" || line.startsWith(":")) continue; // blank / comment (heartbeat ping)
		if (line.startsWith("event:")) event = line.slice(6).trim();
		else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
	}
	if (event === "message" && dataLines.length === 0) return null;
	const raw = dataLines.join("\n");
	let data = raw;
	if (raw.length > 0) {
		try {
			data = JSON.parse(raw);
		} catch {
			data = raw; // leave as string if not JSON
		}
	}
	return { event, data };
}

/** Reduce the raw event list into the structured summary the assertions use. */
function summarize(message, events, fatal) {
	const toolCalls = [];
	let conversationId = null;
	let durationMs = null;
	let sawDone = false; // a `done` frame => the stream reached a normal end

	for (const ev of events) {
		const d = ev.data ?? {};

		if (ev.event === "conversation_created" && d.id) {
			conversationId = d.id;
		} else if (ev.event === "done") {
			sawDone = true;
			if (typeof d.durationMs === "number") durationMs = d.durationMs;
		} else if (ev.event === "tool_execution_start") {
			toolCalls.push({
				id: d.toolCallId,
				toolName: d.toolName ?? "execute_code",
				code: d.args?.code ?? "",
				progress: [],
				isError: false,
				stdout: "",
				displays: [],
				errorText: "",
			});
		} else if (ev.event === "tool_execution_update") {
			const tc = toolCalls.find((t) => t.id === d.toolCallId);
			if (tc) tc.progress.push(d.details?.type ?? "update");
		} else if (ev.event === "tool_execution_end") {
			const tc = toolCalls.find((t) => t.id === d.toolCallId);
			if (!tc) continue;
			tc.isError = d.isError === true;
			const result = d.result ?? {};
			const text = (result.content ?? [])
				.map((c) => (c && typeof c === "object" && "text" in c ? c.text : ""))
				.join("\n");
			if (tc.isError) tc.errorText = text;
			else tc.stdout = result.details?.stdout ?? "";
			tc.displays = result.details?.displays ?? [];
		}
	}

	// Flatten displays. `find_features`/`search`/`spatial_join` auto-display, so
	// a successful query always lands here. Count features, markers AND pairs
	// (spatial_join emits pairs, not features).
	const displayedGeo = []; // {name?, lat?, lon?}
	let displaysCount = 0;
	for (const tc of toolCalls) {
		for (const disp of tc.displays) {
			for (const f of disp?.features ?? []) {
				displaysCount++;
				displayedGeo.push({ name: f.name, lat: f.lat, lon: f.lon });
			}
			for (const m of disp?.markers ?? []) {
				displaysCount++;
				displayedGeo.push({ name: m.label, lat: m.lat, lon: m.lon });
			}
			for (const p of disp?.pairs ?? []) {
				displaysCount++;
				if (p?.point) displayedGeo.push({ name: p.point.name, lat: p.point.lat, lon: p.point.lon });
				if (p?.target)
					displayedGeo.push({ name: p.target.name, lat: p.target.lat, lon: p.target.lon });
			}
		}
	}
	const displayedNames = displayedGeo.map((g) => g.name).filter(Boolean);

	const tag = fatal?.errorTag;
	const madeToolCalls = toolCalls.length > 0;
	const hadAnswer = displaysCount > 0;

	// Status taxonomy — this is the deterministic core the `answered` assert gates on.
	//   answered         — agent reached a displayed map result
	//   gave_up          — made tool calls but produced zero displays (the failure
	//                      mode this suite exists to catch)
	//   no_tool_call     — agent finished (done) without ever writing code
	//   empty_stream     — stream ended with NO terminal `done`/`error` and so was
	//                      cut before a normal end (infra: deploy, proxy timeout,
	//                      cache-skipped spacing…). Not the agent's fault.
	//   service_busy     — OSM backing service overloaded (transient, not agent's fault)
	//   budget_exceeded  — hit the conversation turn/token cap
	//   error            — other fatal error event
	let status;
	if (tag && SERVICE_BUSY_TAGS.has(tag)) status = "service_busy";
	else if (tag === "BudgetExceeded") status = "budget_exceeded";
	else if (fatal) status = "error";
	else if (!sawDone) status = "empty_stream";
	else if (hadAnswer) status = "answered";
	else if (!madeToolCalls) status = "no_tool_call";
	else status = "gave_up";

	return {
		message,
		conversationId,
		durationMs,
		toolCalls,
		displayedNames,
		displayedGeo: displayedGeo.slice(0, 20), // cap for the transcript
		displaysCount,
		toolCallCount: toolCalls.length,
		retryCount: Math.max(0, toolCalls.length - 1),
		errorToolCallCount: toolCalls.filter((t) => t.isError).length,
		errorEvent: fatal ?? null,
		status,
	};
}

/** Render the structured summary into the text the llm-rubric judge grades. */
function renderTranscript(s) {
	const L = [];
	L.push(`PROMPT: ${s.message}`, "");

	L.push(
		`TOOL CALLS: ${s.toolCallCount}  (retries: ${s.retryCount}, errors: ${s.errorToolCallCount})`,
	);
	if (s.toolCallCount === 0) L.push("  (agent made no execute_code calls)");
	s.toolCalls.forEach((tc, i) => {
		L.push(`[${i + 1}] ${tc.toolName}  (id: ${tc.id ?? "?"})${tc.isError ? "  ERROR" : "  OK"}`);
		if (tc.code) {
			L.push("    code:");
			for (const line of tc.code.split("\n")) L.push(`      ${line}`);
		}
		if (tc.isError) {
			if (tc.errorText) L.push(`    error: ${tc.errorText.trim()}`);
		} else if (tc.stdout) {
			L.push("    stdout:");
			for (const line of tc.stdout.split("\n")) L.push(`      ${line}`);
		}
	});

	L.push("");
	L.push(`DISPLAYS: ${s.displaysCount} item(s) on the map`);
	if (s.displayedGeo.length > 0) {
		L.push("  sample (name @ lat, lon):");
		for (const g of s.displayedGeo) {
			const name = g.name ?? "(unnamed)";
			const coord =
				typeof g.lat === "number" && typeof g.lon === "number"
					? `${g.lat.toFixed(4)}, ${g.lon.toFixed(4)}`
					: "no coords";
			L.push(`    - ${name} @ ${coord}`);
		}
	}

	L.push("");
	L.push(`STATUS: ${s.status}`);
	if (s.errorEvent) L.push(`FATAL ERROR: ${JSON.stringify(s.errorEvent)}`);
	if (s.durationMs != null) L.push(`duration: ${Math.round(s.durationMs / 1000)}s`);

	return L.join("\n");
}

export { callApi, summarize };

// promptfoo's file-provider loader does `new (importModule(path))(...)` on the
// default export, so it must be a class with an instance `callApi`. This thin
// wrapper delegates to the standalone `callApi` above (also used directly by
// the probe script, without promptfoo in the loop).
export default class PixiesProvider {
	id() {
		return "pixies-sse";
	}
	callApi(prompt, maybeOptions, maybeContext) {
		return callApi(prompt, maybeOptions, maybeContext);
	}
}
