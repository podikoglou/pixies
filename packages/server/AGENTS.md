# @pixies/server

Bun HTTP server.

Conversations are in-memory with a 24-hour TTL sweep. No persistence.
Only one prompt runs per conversation at a time — concurrent POSTs get 409.
