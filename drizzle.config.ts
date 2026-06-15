import { defineConfig } from "drizzle-kit";

export default defineConfig({
	out: "./drizzle",
	schema: "./packages/core/src/db/schema.ts",
	dialect: "sqlite",
	dbCredentials: {
		url: process.env.PIXIES_DB_FILE ?? "pixies.db",
	},
});
