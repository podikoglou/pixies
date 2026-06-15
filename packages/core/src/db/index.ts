import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema.ts";

export function createDb(dbPath: string) {
	return drizzle({ connection: dbPath, schema, casing: "snake_case" });
}

export { conversations } from "./schema.ts";

export type DbClient = ReturnType<typeof createDb>;
