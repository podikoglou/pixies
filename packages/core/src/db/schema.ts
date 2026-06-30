import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export const conversations = sqliteTable("conversations", {
	id: text("id").primaryKey(),
	// `$type<>` is compile-time only — persisted JSON is untrusted and MUST be
	// re-validated at the read boundary. Guard: `isPersistedTranscript`
	// (`@pixies/core` persisted-transcript). See ADR-0008.
	transcript: text("transcript", { mode: "json" }).$type<AgentMessage[]>(),
	createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
	updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});
