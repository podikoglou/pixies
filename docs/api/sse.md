# Pixies SSE API Specification

**Version:** 0.1.0
**Status:** Live

## Overview

The Pixies SSE API exposes a stateful, multi-tenant conversation interface to the Pixies OSM agent. Each conversation is server-side and isolated from every other. Clients create a conversation, send messages, and receive streamed tool execution progress.

The API is optimized for streaming chat UIs (web, mobile). It is **not** a stateless completion API — clients must track conversation IDs.

## Base URL

```
http://<host>:<port>/
```

Server configuration via env vars — see [docs/DOCKER.md](../DOCKER.md#environment-variables) for the full table.

## Authentication

None in v0.1. The server uses a single server-side LLM API key (`PIXIES_API_KEY`) for all conversations. Per-user auth is a future concern (see Open Questions).

## Media Types

| Context | Content-Type |
|---|---|
| Request body | `application/json` |
| Error response body | `application/json` |
| Streaming success response | `text/event-stream` |

## SSE Framing

Standard Server-Sent Events wire format. Each event:

```
event: <name>
data: <json-string>

```

(Two newlines terminate an event.) Multi-line `data:` is not used — JSON is always single-line.

## Heartbeats

The server emits an SSE comment line `: ping\n\n` every 15 seconds during long-running streams. Comment lines are not delivered to clients as events — they exist solely to keep the connection alive across proxies and browser idle timeouts.

## Endpoints

### Create conversation

```
POST /conversations
Content-Type: application/json

{ "message": "vegan cafés near camden" }
```

**Response (200):** `text/event-stream`

The first event is always `conversation_created`, containing the new conversation ID. Subsequent events are agent events for the prompt. The stream terminates with `done`.

**Response (400):** `application/json`

```json
{ "error": "missing required field: message" }
```

Also returned on invalid JSON:

```json
{ "error": "invalid JSON" }
```

**Response (429):** `application/json` — per-IP rate limit exceeded; includes an integer `Retry-After` header (seconds). See `PIXIES_HTTP_RATE_LIMIT*`.

**Response (500):** Prompt-level errors surface as in-stream `error` events rather than HTTP 500s on this endpoint.

### Send message to conversation

```
POST /conversations/:id/messages
Content-Type: application/json

{ "message": "narrow to within 1km of the station" }
```

**Response (200):** `text/event-stream` — agent events for the prompt, terminates with `done`.

**Response (404):** `application/json`

```json
{ "error": "conversation not found" }
```

**Response (409):** `application/json`

```json
{ "error": "conversation already has an in-flight prompt" }
```

Returned when a previous prompt on this conversation is still streaming. Clients should retry after the previous stream completes.

**Response (429):** `application/json` — per-IP rate limit exceeded; includes an integer `Retry-After` header (seconds). See `PIXIES_HTTP_RATE_LIMIT*`.

### Get conversation transcript

```
GET /conversations/:id
```

Returns the transcript of a conversation. Each entry in `messages` has role `user` or `toolResult`. Assistant messages are not included — the agent responds with tool calls only (no text), and the client renders map data from tool result details. Tool result messages carry `toolCallId`, `toolName`, `isError`, and the structured `details` payload.

**Response (200):** `application/json`

```json
{
  "id": "01901234-5678-7abc-def0-1234567890ab",
  "messages": [
    { "role": "user", "content": "pharmacies near the Eiffel Tower" },
    {
      "role": "toolResult",
      "toolCallId": "call_abc123",
      "toolName": "execute_code",
      "content": [{ "type": "text", "text": "OK" }],
      "details": {
        "stdout": "geocode(\"Eiffel Tower, Paris\") -> Tour Eiffel (48.858, 2.295)\nfind_features(types=[\"pharmacy\"], around={\"lat\":48.858,\"lon\":2.295,\"radius\":2000}) -> 47 feature(s)\n  top: Pharma 1, Pharma 2, Pharma 3\n",
        "displays": [
          { "features": [{ "id": "node/123", "name": "Pharma 1", "lat": 48.85, "lon": 2.30, "tags": { "amenity": "pharmacy" } }, "..." ] }
        ]
      },
      "isError": false
    }
  ]
}
```

**Response (404):** `application/json` — conversation not found (includes the conversation ID in the error message).

### Delete conversation

```
DELETE /conversations/:id
```

Permanently deletes the conversation. If a prompt is in-flight on this conversation, it is aborted first.

**Response (204):** empty body.

**Response (404):** `application/json` — conversation not found (includes the conversation ID in the error message).

### Health check

```
GET /health
```

**Response (200):** `application/json`

```json
{ "status": "ok", "conversations": 12 }
```

## Events

All events use the framing described above. Payloads are JSON.

### `conversation_created`

Emitted exactly once at the start of `POST /conversations` stream, before any agent events.

```json
{ "id": "01901234-5678-7abc-def0-1234567890ab" }
```

Conversation IDs are UUIDv7 (time-ordered, sortable, URL-safe).

### `tool_execution_start`

Emitted when a tool begins executing. `args` is the validated tool input object. The only tool is `execute_code`; `args.code` is the Python code the model wrote.

```json
{
  "toolCallId": "call_abc123",
  "toolName": "execute_code",
  "args": { "code": "tower = geocode(\"Eiffel Tower, Paris\")\npharmacies = find_features(types=[\"pharmacy\"], area={\"around\": {\"lat\": tower[\"lat\"], \"lon\": tower[\"lon\"], \"radius\": 2000}})" }
}
```

### `tool_execution_update`

Emitted for tool progress updates. `details` is a typed discriminated union (`ToolProgress`) describing the tool's lifecycle before its final result:

| `details.type` | Meaning |
|---|---|
| `"queued"` | The tool is waiting for a shared resource (e.g. the Nominatim rate-limit slot). Clients should display a "queued" indicator. |
| `"running"` | The resource was acquired; the tool is executing. Clears a prior `"queued"` indicator. |

```json
{ "toolCallId": "call_abc123", "details": { "type": "queued" } }
```

```json
{ "toolCallId": "call_abc123", "details": { "type": "running" } }
```

New progress variants may be added to the union; clients should narrow on `details.type` and ignore unknown variants. Final-result details travel separately on `tool_execution_end.result.details` (tool-specific, see below).

### `tool_execution_end`

Emitted when a tool finishes. `result` is the full tool result; `result.content[].text` is the model-facing text. On error, `isError === true` and the error message is in `result.content[].text`.

```json
{
  "toolCallId": "call_abc123",
  "isError": false,
  "result": {
    "content": [{ "type": "text", "text": "OK" }],
    "details": {
      "stdout": "geocode(\"Eiffel Tower, Paris\") -> Tour Eiffel (48.858, 2.295)\n",
      "displays": [{ "features": [{ "id": "node/123", "name": "Pharma 1", "lat": 48.85, "lon": 2.30 }] }]
    }
  }
}
```

There is one tool: `execute_code`. Its `details` shape:

| Tool | `details` shape |
|---|---|
| `execute_code` | `{ stdout: string, displays: DisplayData[] }` — `stdout` is the captured output of the Python code (summary lines from each host function call). `displays` is an array of map-renderable payloads produced by `find_features` (auto-display features), `spatial_join` (auto-display pairs), and explicit `display()` calls. |

Each element in `displays` has type `DisplayData`:

```typescript
{ markers?: { lat: number; lon: number; label?: string }[]
  features?: { id: string; name?: string; lat: number; lon: number; tags?: Record<string, string> }[]
  pairs?: { point: Feature; target: Feature; distance: number }[]
  bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number } }
```

Clients render map data from `details.displays` directly — `content[].text` is the constant string `"OK"` and carries no structured data.

**Busy soft-failure.** When an OSM service reports a transient overload, the host function throws an error. This surfaces as `tool_execution_end` with `isError: true` and the error message in `result.content[].text`. The model is instructed not to retry on service-unavailable errors — it treats them as terminal for that query.

### `done`

Emitted exactly once at the end of every successful stream, after all agent events. Signals that the server is closing the stream.

```json
{ "durationMs": 1250 }
```

### `error`

Emitted when the agent encounters a fatal error during the prompt (provider failure, etc.). The stream terminates after this event.

```json
{ "message": "provider rate limit exceeded" }
```

Tool errors do **not** fire this event — they fire `tool_execution_end` with `isError: true`, and the agent continues normally to the next turn.

### Future events

The following event types are defined in the schema but not currently emitted. The agent responds with tool calls only (no assistant text), so `message_start`/`text_delta`/`message_end` are present for future use but have no current trigger path:

- `message_start` — planned for when the agent begins streaming an assistant message
- `text_delta` — planned for per-token streaming of assistant text
- `message_end` — planned for when an assistant message is complete (full authoritative payload)

Currently, all information reaches the client through `tool_execution_end` details — map data in `displays` and execution output in `stdout`.

## Lifecycle

```
Client                                 Server
  |                                      |
  | POST /conversations                  |
  | { message: "..." }                   |
  |------------------------------------->|
  |                                      | create conversation
  |<- - - - - - - - - - - - - - - - - - | conversation_created { id }
  |<- - - - - - - - - - - - - - - - - - | tool_execution_start { toolName: "execute_code", args: { code } }
  |<- - - - - - - - - - - - - - - - - - | tool_execution_update { details: { type: "queued" } }
  |<- - - - - - - - - - - - - - - - - - | tool_execution_update { details: { type: "running" } }
  |<- - - - - - - - - - - - - - - - - - | tool_execution_end { result: { details: { stdout, displays } } }
  |<- - - - - - - - - - - - - - - - - - | done { durationMs: 1234 }
  |                                      | [stream ends]
  |                                      |
  | POST /conversations/:id/messages     |
  | { message: "..." }                   |
  |------------------------------------->|
  |                                      | lookup, check not streaming
  |<- - - - - - - - - - - - - - - - - - | tool_execution_start { toolName: "execute_code", args: { code } }
  |                               ...    |
  |<- - - - - - - - - - - - - - - - - - | done { durationMs: 1234 }
  |                                      | [stream ends]
```

Multiple `tool_execution_start`/`tool_execution_end` pairs per prompt occur when the model retries after a coding error — each retry is a separate `execute_code` call within the same stream.

## Abort semantics

To abort an in-flight prompt, the client closes the SSE connection. The server detects the closed connection and aborts the in-flight work. The conversation is not deleted — the client can send a new message to continue.

There is no abort endpoint. Closing the connection IS the abort.

## Concurrency

- One in-flight prompt per conversation. Concurrent prompt attempts return **409**.
- **OSM data sources are shared and rate-limited server-wide.** There is no per-conversation isolation from this throttle — under concurrent load tool calls may queue (surfaced as `queued` → `running` progress) or the host functions may throw service-busy errors (surfaced as `tool_execution_end` with `isError: true`).
- **HTTP layer:** the two LLM-cost POST endpoints (`POST /conversations`, `POST /conversations/:id/messages`) are rate-limited per IP in-process. Over the limit → **429** with an integer `Retry-After` (seconds). GET/DELETE are not rate-limited (no LLM cost). See `PIXIES_HTTP_RATE_LIMIT*` in [docs/DOCKER.md](../DOCKER.md).

## Durability

Conversations persist across server restarts — `GET /conversations/:id` returns the transcript after a restart, and the conversation can still receive new messages. The transcript (user messages and tool results) is saved after each completed prompt; assistant text is not stored (see Get transcript).

## CORS

Default: not enabled. For browser clients on a different origin, configure the server to emit appropriate CORS headers (`PIXIES_CORS_ORIGIN` env var, future). For same-origin deployments, no CORS needed.

Native browser `EventSource` cannot set custom headers; cross-origin clients should use `fetch()` with `ReadableStream` instead, or deploy behind a same-origin proxy.

## Examples

### cURL

```bash
curl -N -X POST http://localhost:3000/conversations \
  -H "Content-Type: application/json" \
  -d '{"message":"vegan cafés near camden"}'
```

`-N` disables buffering so SSE events stream live.

### Browser (fetch + ReadableStream)

```js
const res = await fetch("http://localhost:3000/conversations", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ message: "vegan cafés near camden" }),
});

const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();

let buf = "";
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += value;
  const frames = buf.split("\n\n");
  buf = frames.pop();
  for (const raw of frames) {
    const event = parseSseFrame(raw); // your parser
    console.log(event.event, event.data);
  }
}
```

## Open Questions / Future

- **Authentication.** v0 has none. Likely API-key-per-user before public launch.
- **CORS.** Not enabled; configuration planned.
- **WebSocket transport.** Possible alternative to SSE for bidirectional needs (none currently).
- **Mid-execution display streaming.** Currently, map data is delivered atomically at `tool_execution_end`. Live display during code execution (e.g. rendering markers as each `find_features` call completes inside the Monty session) would require SSE events from the Monty executor during the snapshot loop — possible but not yet wired.
- **Rate limiting on the API surface.** Implemented in-process per IP on the two LLM-cost POST endpoints (`PIXIES_HTTP_RATE_LIMIT*`); GET/DELETE are not limited. Caddy-side limiting (defense-in-depth) is a possible future addition — stock Caddy has no rate-limit plugin.
