import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export const conversations = sqliteTable("conversations", {
	id: text("id").primaryKey(),
	transcript: text("transcript", { mode: "json" }).$type<AgentMessage[]>(),
	createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
	updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});
