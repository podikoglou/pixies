# @pixies/server

Bun HTTP server.

Conversations are backed by SQLite persistence (Drizzle ORM, conversationsTable) with an in-memory LRU cache (24h TTL, config.cacheSize). Rehydrates from DB on cache miss.
Only one prompt runs per conversation at a time — concurrent POSTs get 409.
