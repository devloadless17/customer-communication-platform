/**
 * Tears down the mock Graph server + isolated test api started in meta-stack.ts.
 * Only kills processes THIS run spawned (PIDs it recorded) — a reused,
 * already-running stack is left alone.
 */

import verifyCanary from "../isolation-canary.teardown";

export default async function globalTeardown(): Promise<void> {
  // Isolation canary first (while the DB client is still healthy): the
  // sentinel tenant must be byte-identical to the setup's fingerprint.
  await verifyCanary();

  for (const key of ["__META_API_PID", "__META_MOCK_PID"]) {
    const pid = Number(process.env[key]);
    if (!pid) continue;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  // Give the api a moment to drain (server.close → app.close), then hard-kill.
  await new Promise((r) => setTimeout(r, 2500));
  for (const key of ["__META_API_PID", "__META_MOCK_PID"]) {
    const pid = Number(process.env[key]);
    if (!pid) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // drained cleanly
    }
  }
}
