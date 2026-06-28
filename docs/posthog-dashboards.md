# PostHog dashboards & alerts

The operational runbook for building the agent-loop observability views in PostHog — the dashboards and alerts that turn the captured events into loop health you can read at a glance. Provisioned in PostHog project settings, not in code.

## Prerequisites

Every view here is built on events that Pixies already captures, so nothing new ships:

- The server analytics events must be flowing into PostHog. Their names, distinctIds, and property shapes are the contract in [docs/posthog-privacy.md](posthog-privacy.md) (the authoritative event table) and the typed mirror in `packages/server/src/analytics-events.ts`.
- Alert destinations (Discord / Slack / Teams / webhook) are configured once in PostHog project settings; see the alerting section of [docs/posthog-privacy.md](posthog-privacy.md). This page only references destinations, it does not reconfigure them.

distinctIds on every event below are conversation ids (rate-limit events key on client IP), so "per conversation" grouping is a grouping by distinctId. No view crosses the server/web id boundary — the browser's anonymous id is deliberately unlinked.

## Dashboards

Each dashboard is a PostHog dashboard composed of the insights below. An insight is specified by its source event(s), the property or math applied, and any breakdown or filter — the click-path in the PostHog UI is omitted because it rots; the event contract is the stable interface.

### Loop health

How the agent loop behaves per turn and per conversation.

| Insight | Question | Event | Math / property | Breakdown |
| --- | --- | --- | --- | --- |
| Turns per conversation | how many turns a conversation takes; where runaway loops form | `agent turn` | count, grouped by distinctId, bucketed into a distribution | — |
| Tool calls per turn | how many tools fire each turn | `agent turn` | average / distribution of `tool_calls` | — |
| Stop reason mix | why turns end | `agent turn` | count | `stop_reason` |
| "Did nothing" slice | turns that called no tool and stopped anyway | `agent turn` | count, filtered to `tool_calls == 0` and `stop_reason == stop` | — |

`stop_reason == stop` is the model's natural end-of-turn signal; `tool_calls == 0` at that point means the turn produced no tool activity, which is the "agent did nothing" population the loop has no `max_turns` guard against today.

### Latency

How fast the stream and its tools respond.

| Insight | Question | Event | Math / property | Breakdown |
| --- | --- | --- | --- | --- |
| First-token latency | how long until the user sees output | `agent stream first token` | p50 / p90 / p99 of `ttft_ms` | — |
| Stream duration | how long a full stream takes to complete | `agent stream done` | p50 / p90 / p99 of `duration_ms` | — |
| Per-tool latency | which tools are slow | `tool call` | p50 / p90 of `duration_ms` | `tool_name` |
| Disconnects | streams that never complete (user gave up) | `agent stream disconnect` | count; average `elapsed_ms` | — |

Raw integer milliseconds are captured (not coarse buckets), so PostHog computes the percentiles natively. `agent stream first token` fires mid-stream, so even later-aborted streams contribute a TTFT; `agent stream done` fires only on normal completion, so aborted streams are never miscounted as fast.

### Cost

Token spend per turn and per conversation, and proximity to the budget.

| Insight | Question | Event | Math / property | Breakdown |
| --- | --- | --- | --- | --- |
| Tokens per turn | per-turn model cost | `agent turn` | sum of `input_tokens + output_tokens`, averaged | — |
| Tokens per conversation | per-conversation model cost | `agent turn` | sum of `input_tokens + output_tokens`, grouped by distinctId | — |
| Cache-read tokens | how much read cache is reused | `agent turn` | sum of `cache_read_tokens` (optional property) | — |
| Budget exceeded | conversations that hit the token budget | `conversation budget exceeded` | count; unique distinctIds | — |

The token budget itself rides on the `conversation budget exceeded` event as `token_budget`, so the "approaching the budget" view is the per-conversation token sum trending toward that ceiling — the event marks the moment it is crossed.

### Tool reliability

Which tools succeed, which fail, and how.

| Insight | Question | Event | Math / property | Breakdown |
| --- | --- | --- | --- | --- |
| Outcome mix per tool | the full success/failure shape | `tool call` | count | `tool_name`, `outcome` |
| Error rate per tool | which tools throw | `tool call` | count filtered to `outcome == error`, normalised per tool | `tool_name` |
| Busy rate | Nominatim / Overpass overload (non-error stall) | `tool call` | count filtered to `outcome == busy` | `tool_name` |
| Empty-result rate | data-fetch tools that return zero features | `tool call` | count filtered to `outcome == empty` | `tool_name` |
| Queue wait | rate-limiter stall before a tool runs | `tool call` | p90 of `queue_wait_ms` (optional property) | `tool_name` |

`outcome` is the server-derived enum (`error` / `busy` / `empty` / `success`) that unifies what the client-side `tool_error` / `tool_empty` events only see for data-fetch tools; `busy` is the soft-failure the busy-recovery path otherwise hides as success.

## Alerts

PostHog thresholds and dedupes alerts over the same events. Threshold windows are ranges, not fixed numbers: tune them after a baseline week of data so a steady-state blip does not page and a real regression does.

| Alert | Trigger event | Condition | Window |
| --- | --- | --- | --- |
| Stream error spike | `agent stream error` | volume above baseline (spike detection, or N-of-M count) | 5–60 min |
| New failure mode | `agent stream error` | a previously-unseen `error_tag` value appears | rolling |
| Busy overload | `tool call` | `outcome == busy` rate above threshold | 5–30 min |
| Runaway loop | `agent turn` | turn count per conversation above threshold | rolling |
| Latency regression | `agent stream first token` / `agent stream done` | p90 above threshold | 15–60 min |

The `error_tag` on `agent stream error` is optional — only errors that carry a typed `_tag` populate it — so "new failure mode" fires on the subset that is discriminable; a raw error spike is the catch-all alert for the rest. Runaway-loop alerting pairs with a future `max_turns` guard: until that guard exists, the alert is the only signal that a conversation is turning in circles.

## Privacy

No view here collects new data. Dashboards and alerts read only the events already in PostHog, which carry coarse metadata — counts, ids, tags, durations — never message, query, or place text. The privacy contract for every event is in [docs/posthog-privacy.md](posthog-privacy.md); this page consumes it, it does not extend it.
