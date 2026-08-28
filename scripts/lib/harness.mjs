// Shared plumbing for the proof scripts in this directory. Each of them
// spins up its own throwaway gateway/upstream processes on dedicated ports
// so a run can't collide with anything else you have running locally.

import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";

export const ROOT = path.join(import.meta.dirname, "..", "..");
const TSX_BIN = path.join(ROOT, "node_modules", ".bin", "tsx");

export function spawnProcess(name, scriptPath, env) {
  // Invoke the locally-installed tsx binary directly rather than going
  // through `npx tsx` — npx's resolution behaves differently across
  // environments (it hung indefinitely in GitHub Actions CI despite
  // working fine locally, even though tsx is already a devDependency and
  // should never need to be fetched).
  const child = spawn(TSX_BIN, [scriptPath], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => process.stdout.write(`[${name}] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[${name}] ${d}`));
  return child;
}

export async function waitForHealthy(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${url} never became healthy`);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A port that is definitely not accepting connections: bind port 0, let the
 * OS pick a free one, then release it. Used to point a gateway at a Redis
 * that provably isn't there, without the test depending on some hardcoded
 * port happening to be empty on the machine running it.
 */
export function findClosedPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Terminates spawned children, tolerating ones that already exited. */
export function killAll(...children) {
  for (const child of children) {
    try {
      child.kill();
    } catch {
      // already gone
    }
  }
}

export function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(sortedValues.length - 1, Math.ceil((p / 100) * sortedValues.length) - 1);
  return sortedValues[index];
}
