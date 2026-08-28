import { readFileSync } from "node:fs";
import path from "node:path";
import type { Redis } from "ioredis";

// Lua files live in src/scripts at dev time (run via tsx) and get copied to
// dist/scripts at build time (see Dockerfile) so this same relative lookup
// works in both.
function loadScript(filename: string): string {
  return readFileSync(path.join(import.meta.dirname, "..", "scripts", filename), "utf-8");
}

// Registration is per-client rather than done once against the module-level
// singleton at import time. The limiters accept an injected Redis client, and
// with import-time registration that parameter was a trap: any client other
// than the singleton would reach `client.tokenBucket(...)` and find it
// undefined, because defineCommand had only ever been called on the
// singleton. Registering against whichever client the limiter was handed
// makes the injection point real, which is what lets the tests drive these
// against their own connection.
const registered = new WeakMap<Redis, Set<string>>();

/**
 * Attach a Lua script to a Redis client as a custom command. ioredis's
 * defineCommand handles the EVALSHA/EVAL dance for us: it sends EVALSHA and
 * transparently falls back to EVAL (re-caching the script) if Redis reports
 * NOSCRIPT, which happens after a Redis restart or SCRIPT FLUSH.
 */
export function registerScript(
  client: Redis,
  commandName: string,
  filename: string,
  numberOfKeys: number
): void {
  let names = registered.get(client);
  if (!names) {
    names = new Set();
    registered.set(client, names);
  }
  if (names.has(commandName)) return;
  client.defineCommand(commandName, { numberOfKeys, lua: loadScript(filename) });
  names.add(commandName);
}
