/**
 * Next.js boot hook — called once per server process (dev + prod).
 *
 * Runs fail-fast env validation via @ccp/config so the web container exits
 * with a legible message if a required var is missing, instead of starting
 * and 500'ing on the first request that needs the missing config.
 *
 * Guard on NEXT_RUNTIME === "nodejs" — instrumentation also fires in the
 * edge runtime, where validateEnv's `process.exit` doesn't exist and where
 * the web process's env contract doesn't apply anyway.
 *
 * Reference: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { validateEnv } = await import("@ccp/config");
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
