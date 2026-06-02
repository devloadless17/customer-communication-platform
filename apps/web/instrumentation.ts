/**
 * Next.js boot hook — called once per server process (dev + prod).
 *
 * Runs fail-fast env validation + installs the process-level error nets. All of
 * that uses Node-only APIs (`process.on`, `process.exit`), so it lives in
 * `instrumentation-node.ts` and is loaded via a dynamic import GATED on
 * NEXT_RUNTIME === "nodejs". instrumentation.ts itself is compiled for BOTH the
 * node and edge runtimes; keeping the Node APIs out of this module's static
 * graph stops Turbopack from warning "process.on is not supported in the Edge
 * Runtime" on every request (the runtime guard alone doesn't satisfy the
 * static analyzer).
 *
 * Reference: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { registerNode } = await import("./instrumentation-node");
  registerNode();
}
