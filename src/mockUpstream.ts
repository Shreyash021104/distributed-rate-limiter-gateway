// A stand-in for "the real backend service" the gateway protects. Doing
// anything more elaborate than echoing the request would be beside the
// point — the gateway is what's under test here, not this.
import express from "express";
import { env } from "./env.js";

const app = express();

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("*splat", (req, res) => {
  res.json({
    ok: true,
    path: req.path,
    servedBy: env.instanceId,
    at: new Date().toISOString(),
  });
});

app.listen(env.mockUpstreamPort, () => {
  console.log(`Mock upstream listening on http://localhost:${env.mockUpstreamPort}`);
});
