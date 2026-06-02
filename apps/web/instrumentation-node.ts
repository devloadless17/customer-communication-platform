/**
 * Node-only instrumentation. Split out of instrumentation.ts and loaded via a
 * dynamic import (behind a NEXT_RUNTIME === "nodejs" guard in register()) so the
 * EDGE compilation of instrumentation.ts never statically sees `process.on` /
 * `process.exit`. Turbopack flags those Node APIs as unsupported-in-edge even
 * when they sit behind a runtime check it can't prove — which spammed the dev
 * logs with "A Node.js API is used (process.on) ... Edge Runtime" on every
 * request. Moving them into a dynamically-imported module is Next.js's
 * documented fix.
 *
 * Reference: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

import { validateEnv } from "@ccp/config";

export function registerNode(): void {
  // Fail-fast env validation — exits the web container with a legible message
  // if a required var is missing, instead of starting and 500'ing on the first
  // request that needs the missing config.
  validateEnv("web");

  // Global last-resort net, mirroring the api process (main.ts). A stray
  // unhandled rejection (e.g. a fire-and-forget fetch in a server action that
  // loses its `.catch`) would otherwise terminate the web process under
  // Node 24's default `--unhandled-rejections=throw`, turning a single bad
  // request into a hard 502 for everyone until the container restarts. Log so
  // it's visible, then survive — the request that triggered it already failed
  // on its own path; the process staying up keeps every other user served.
  process.on("unhandledRejection", (reason) => {
    console.error("[web][unhandledRejection]", reason);
  });
  process.on("uncaughtException", (err) => {
    console.error("[web][uncaughtException]", err);
  });
}
