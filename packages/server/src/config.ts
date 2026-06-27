import path from "node:path";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { env } from "@pixies/core";

/**
 * Server-only boot configuration: filesystem paths the server resolves at
 * startup. `webDist` locates the web SPA bundle — a UI-asset concept core has
 * no business owning. `migrationsFolder` locates Drizzle's migration metadata:
 * core owns the drizzle client and schema, but `migrate()` is called only from
 * the server boot path, so the folder is a server runtime concern, not a
 * kernel one. Declared here rather than folded into core's `PixiesConfigSchema`
 * — see ADR-0011.
 */
export const ServerConfigSchema = Type.Object({
	webDist: Type.String({
		default: path.resolve(import.meta.dir, "../../web/dist"),
		description: "Directory the server serves the web SPA from",
	}),
	migrationsFolder: Type.String({
		default: path.resolve(import.meta.dir, "../../../drizzle"),
		description: "Directory holding Drizzle migration metadata",
	}),
});

export type ServerConfig = Static<typeof ServerConfigSchema>;

/**
 * Resolve server boot paths from `PIXIES_WEB_DIST` / `PIXIES_MIGRATIONS_FOLDER`,
 * applying the `import.meta.dir`-relative defaults when unset. Uses the same
 * `Value.Default` + `Value.Parse` pipeline core's `readConfigFromEnv` uses, so
 * every `PIXIES_*` var now flows through a TypeBox schema the same way.
 */
export function readServerConfigFromEnv(): ServerConfig {
	return Value.Parse(
		ServerConfigSchema,
		Value.Default(ServerConfigSchema, {
			webDist: env("PIXIES_WEB_DIST"),
			migrationsFolder: env("PIXIES_MIGRATIONS_FOLDER"),
		}),
	);
}
