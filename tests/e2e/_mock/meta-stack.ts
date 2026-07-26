/**
 * Boot/teardown for the Meta-channels backend suite's dedicated stack:
 *
 *   - a mock Graph server on :4100 (records outbound wire shapes), and
 *   - a SECOND api process on :4001 launched with `META_GRAPH_BASE_URL` → the
 *     mock and an ISOLATED Redis DB (index 5) so its `message-sends` worker can
 *     never pick up (or leak into) the maintainer's live :4000 stack.
 *
 * Both are spawned detached in globalSetup and killed in globalTeardown; PIDs
 * ride through `process.env` between the two hooks (same Playwright process).
 * If something is already listening (a prior run left it up), we reuse it.
 */

import { spawn } from "node:child_process";
import { existsSync, openSync } from "node:fs";
import { resolve } from "node:path";

import { ensureCanary, canaryFingerprint, writeFingerprint } from "../_helpers/canary";

const MOCK_PORT = 4100;
const API_PORT = 4001;
const REPO_ROOT = resolve(__dirname, "../../..");
const LOG_DIR = resolve(REPO_ROOT, "tests/e2e/.meta-logs");

async function isUp(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitUp(url: string, label: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isUp(url)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`[meta-stack] ${label} did not come up at ${url} within ${timeoutMs}ms`);
}

function logFile(name: string): number {
  // openSync in append mode; the dir is created by the caller.
  return openSync(resolve(LOG_DIR, name), "a");
}

export default async function globalSetup(): Promise<void> {
  const { mkdirSync } = await import("node:fs");
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

  // Isolation canary: plant + fingerprint the sentinel NON-e2e tenant so the
  // teardown can prove this suite never wrote outside its `e2e-meta-team`
  // scope. Same tripwire as the main config (see tests/e2e/_helpers/canary.ts).
  await ensureCanary();
  writeFingerprint(await canaryFingerprint());

  // ---- Mock Graph server ------------------------------------------------
  if (!(await isUp(`http://127.0.0.1:${MOCK_PORT}/__mock/health`))) {
    const out = logFile("graph-mock.log");
    const mock = spawn("node", [resolve(REPO_ROOT, "tests/e2e/_mock/graph-mock.mjs")], {
      cwd: REPO_ROOT,
      env: { ...process.env, MOCK_PORT: String(MOCK_PORT) },
      detached: true,
      stdio: ["ignore", out, out],
    });
    mock.unref();
    if (mock.pid) process.env.__META_MOCK_PID = String(mock.pid);
    await waitUp(`http://127.0.0.1:${MOCK_PORT}/__mock/health`, "graph-mock");
  }

  // ---- Isolated test api ------------------------------------------------
  if (!(await isUp(`http://127.0.0.1:${API_PORT}/health`))) {
    const out = logFile("test-api.log");
    const api = spawn(
      "node",
      // `--env-file-if-exists`: locally the root .env feeds the boot exactly as
      // before; in CI there is no .env (services + job env provide everything)
      // and a plain `--env-file` would refuse to start Node at all.
      ["--env-file-if-exists=../../.env", "-r", "@swc-node/register", "./src/main.ts"],
      {
        cwd: resolve(REPO_ROOT, "apps/api"),
        env: {
          ...process.env,
          // Inline env wins over --env-file on Node ≥20, so these override .env.
          API_PORT: String(API_PORT),
          META_GRAPH_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
          META_FETCH_TIMEOUT_MS: "3000",
          // The root .env carries META_WEBHOOK_INSECURE_SKIP_VERIFY=1 — a
          // legitimate local-dev crutch for tunnelled webhooks. Inheriting it
          // here silently disarms the HMAC gate, so "a bad signature is
          // rejected" passed by accident for as long as the flag was off and
          // failed confusingly once it went on. Either way the suite was not
          // testing what it claims. Forced OFF so the signature specs exercise
          // the real gate; the harness signs its own payloads correctly, so
          // nothing else is affected.
          META_WEBHOOK_INSECURE_SKIP_VERIFY: "0",
          REDIS_URL: `${process.env.REDIS_URL ?? "redis://localhost:6380"}/5`,
          RUN_WORKER_INLINE: "1",
          SWC_NODE_PROJECT: "./tsconfig.json",
          NODE_OPTIONS: "--max-old-space-size=1024 --conditions=react-server",
        },
        detached: true,
        stdio: ["ignore", out, out],
      },
    );
    api.unref();
    if (api.pid) process.env.__META_API_PID = String(api.pid);
    await waitUp(`http://127.0.0.1:${API_PORT}/health`, "test-api", 90_000);
  }
}
