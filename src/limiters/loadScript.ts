import { readFileSync } from "node:fs";
import path from "node:path";

// Lua files live in src/scripts at dev time (run via tsx) and get copied to
// dist/scripts at build time (see Dockerfile) so this same relative lookup
// works in both.
export function loadScript(filename: string): string {
  return readFileSync(path.join(import.meta.dirname, "..", "scripts", filename), "utf-8");
}
