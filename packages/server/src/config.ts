import path from "node:path";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

/**
 * Server-only boot configuration: filesystem paths the server resolves at
 * startup that have no meaning in `@pixies/core` (the kernel has no concept of
 * the web SPA bundle or the Drizzle migrations folder). Declared here rather
 * than folded into core's `PixiesConfigSchema` to keep UI/HTTP concerns out of
 * the kernel — see ADR-0011.
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
 * Read an env var, treating undefined/empty/whitespace as unset (returns
 * undefined) so the schema applies its documented default. Mirrors core's
 * `env()` helper in `agent.ts` so both config surfaces agree on empty-as-unset.
 */
function env(name: string): string | undefined {
	const v = process.env[name];
	return v && v.trim().length > 0 ? v : undefined;
}

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
