# Pixies SSE API Specification

**Version:** 0.1.0
**Status:** Draft

## Overview

The Pixies SSE API exposes a stateful, multi-tenant conversation interface to the Pixies OSM agent. Each conversation is an isolated server-side `Agent` instance. Clients create a conversation, send messages, and receive streamed assistant responses including tool execution progress.

The API is optimized for streaming chat UIs (web, mobile). It is **not** a stateless completion API — clients must track conversation IDs.

## Base URL

```
http://<host>:<port>/
```

Server configuration via env vars:

| Var | Default | Purpose |
|---|---|---|
| `PIXIES_HOST` | `127.0.0.1` | Bind address |
| `PIXIES_PORT` | `3000` | Bind port |
| `PIXIES_API_KEY` | (required) | LLM provider API key, shared across all conversations |
| `PIXIES_MODEL` | (required) | `provider/model-id` (e.g. `anthropic/claude-sonnet-4-20250514`) |
| `PIXIES_CONTACT_EMAIL` | (optional) | Passed to Nominatim/Overpass as `email=` per OSM usage policy |
| `PIXIES_OVERPASS_URL` | (optional) | Override Overpass endpoint |
| `PIXIES_NOMINATIM_URL` | (optional) | Override Nominatim endpoint |

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

The server emits an SSE comment line `: ping\n\n` every 15 seconds during long-running streams (e.g. while an Overpass query runs). Comment lines are not delivered to clients as events — they exist solely to keep the connection alive across proxies and browser idle timeouts.

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

**Response (500):** `application/json`

```json
{ "error": "internal server error" }
```

500s on this endpoint are rare — the `Agent` is freshly created, so prompt-level errors surface as in-stream `error` events rather than HTTP errors.

### Send message to conversation

```
POST /conversations/:id/messages
Content-Type: application/json

{ "message": "narrow to within 1km of the station" }
```

**Response (200):** `text/event-stream` — agent events for the prompt, terminates with `done`.

**Response (404):** `application/json`

```json
{ "error": "conversation not found: 01901234-5678-7abc-def0-1234567890ab" }
```

**Response (409):** `application/json`

```json
{ "error": "conversation already has an in-flight prompt" }
```

Returned when a previous prompt on this conversation is still streaming. Clients should retry after the previous stream completes.

### Get conversation transcript

```
GET /conversations/:id
```

Returns the full reconstructed transcript of a conversation. The response shape is consistent with the `message_end` SSE event payload — each entry in `messages` is an assistant message with `{ role, content, stopReason }`.

**Response (200):** `application/json`

```json
{
  "id": "01901234-5678-7abc-def0-1234567890ab",
  "messages": [
    { "role": "assistant", "content": [...], "stopReason": "stop" }
  ]
}
```

**Response (404):** `application/json` — conversation not found.

### Delete conversation

```
DELETE /conversations/:id
```

Evicts the conversation from server memory immediately. If a prompt is in-flight on this conversation, it is aborted first.

**Response (204):** empty body.

**Response (404):** `application/json` — conversation not found.

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

### `message_start`

Emitted when the agent begins streaming a new assistant message. A single prompt can produce multiple assistant messages (e.g. one before tool calls, one after).

```json
{}
```

### `text_delta`

Emitted per token of assistant text. Concatenate `delta` values to reconstruct the full text.

```json
{ "delta": "Hello" }
```

### `message_end`

Emitted when the current assistant message is complete. Payload is the full authoritative message — clients may replace their accumulated state with this to handle any provider-side reordering.

```json
{ "message": { "role": "assistant", "content": [], "stopReason": "stop" } }
```

The `message.content` array may include `{ type: "text", text: "..." }` and `{ type: "toolCall", ... }` blocks; clients typically only render the text blocks.

### `tool_execution_start`

Emitted when a tool begins executing. `args` is the validated tool input object.

```json
{
  "toolCallId": "call_abc123",
  "toolName": "geocode",
  "args": { "query": "Camden, London" }
}
```

### `tool_execution_update`

Emitted for tool progress updates. Currently used only to surface the Nominatim rate-limit queue state — clients should display a "queued" indicator when `details.queued === true`.

```json
{ "toolCallId": "call_abc123", "details": { "queued": true } }
```

Future update shapes may be added; clients should ignore unknown `details` fields.

### `tool_execution_end`

Emitted when a tool finishes. `result` is the full tool result; `result.content[].text` is the model-facing text (clients can render this as a multi-line card, same as the TUI). On error, `isError === true` and the error message is in `result.content[].text`.

```json
{
  "toolCallId": "call_abc123",
  "isError": false,
  "result": {
    "content": [{ "type": "text", "text": "node/123 | ..." }],
    "details": { "count": 47 }
  }
}
```

The `details` shape is tool-specific. For v0.1:

| Tool | `details` shape |
|---|---|
| `geocode` | `{ top: string }` — short summary of the top result, e.g. `"Camden Town (51.539,-0.142)"` |
| `reverse_geocode` | `{ name: string }` — short place name |
| `query_osm` | `{ count: number }` — element count returned |

Clients may render `details` as a status line on the tool card.

### `done`

Emitted exactly once at the end of every successful stream, after all agent events. Signals that the server is closing the stream.

```json
{}
```

### `error`

Emitted when the agent encounters a fatal error during the prompt (provider failure, etc.). The stream terminates after this event.

```json
{ "message": "provider rate limit exceeded" }
```

Tool errors do **not** fire this event — they fire `tool_execution_end` with `isError: true`, and the agent continues normally to the next turn.

## Lifecycle

```
Client                                 Server
  |                                      |
  | POST /conversations                  |
  | { message: "..." }                   |
  |------------------------------------->|
  |                                      | create Agent, store in Map
  |<- - - - - - - - - - - - - - - - - - | conversation_created { id }
  |                                      |
  |<- - - - - - - - - - - - - - - - - - | message_start
  |<- - - - - - - - - - - - - - - - - - | text_delta { delta: "I'll " }
  |<- - - - - - - - - - - - - - - - - - | text_delta { delta: "search..." }
  |<- - - - - - - - - - - - - - - - - - | message_end { message }
  |<- - - - - - - - - - - - - - - - - - | tool_execution_start { ... }
  |<- - - - - - - - - - - - - - - - - - | tool_execution_update { queued: true }
  |<- - - - - - - - - - - - - - - - - - | tool_execution_update { queued: false }
  |<- - - - - - - - - - - - - - - - - - | tool_execution_end { ... }
  |<- - - - - - - - - - - - - - - - - - | message_start
  |<- - - - - - - - - - - - - - - - - - | text_delta { ... }
  |<- - - - - - - - - - - - - - - - - - | message_end { message }
  |<- - - - - - - - - - - - - - - - - - | done
  |                                      | [stream ends]
  |                                      |
  | POST /conversations/:id/messages     |
  | { message: "..." }                   |
  |------------------------------------->|
  |                                      | lookup, check not streaming
  |<- - - - - - - - - - - - - - - - - - | message_start
  |                               ...    |
  |<- - - - - - - - - - - - - - - - - - | done
  |                                      | [stream ends]
```

## Abort semantics

To abort an in-flight prompt, the client closes the SSE connection. The server detects the disconnect via the request `close` event and calls `agent.abort()`. The conversation remains in memory — the client can send a new message to continue.

There is no abort endpoint. Closing the connection IS the abort.

## Concurrency

- One in-flight prompt per conversation. Concurrent prompt attempts return **409**.
- No cross-conversation serialization (beyond the shared Nominatim rate-limit mutex, which is global to the server's source IP).

## Conversation TTL

Conversations are evicted from server memory after **1 hour** of inactivity (no POST messages). A sweeper runs every 5 minutes.

Server restart evicts all conversations immediately.

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
- **Persistence.** None. Browser `sessionStorage` if the client wants to survive page refresh within a tab.
- **CORS.** Not enabled; configuration planned.
- **WebSocket transport.** Possible alternative to SSE for bidirectional needs (none currently).
- **Rate limiting on the API surface.** None. OSM rate limits are enforced internally; API surface trusts clients.
