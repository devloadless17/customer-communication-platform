/**
 * Dev-only Meta "wire log" — prints, in real time, EVERY HTTP request/response
 * we send to Meta (outbound) AND every webhook Meta sends us (inbound), so you
 * can watch exactly what's on the wire while debugging or tuning payloads.
 *
 * OFF by default. Turn it on for the api process only:
 *
 *   DEBUG_META_WIRE=1 pnpm dev          # or add DEBUG_META_WIRE=1 to apps/api/.env
 *
 * Then tail the api terminal: outbound calls print cyan (`→ META …`) with the
 * request body + Meta's response; inbound webhooks print magenta (`← WEBHOOK …`)
 * with the raw payload. Never prints the access token (callers pass a redacted
 * URL). Fully guarded — logging must NEVER throw into a send/ingest path. This
 * is a diagnostics aid, not a durable audit; leave it OFF in production.
 */
const ON =
  process.env.DEBUG_META_WIRE === "1" ||
  process.env.DEBUG_META_WIRE === "true";

export function metaWireEnabled(): boolean {
  return ON;
}

/** Pretty-print a value (JSON string → parsed + indented) for readable logs. */
function pretty(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") {
    const t = v.trim();
    if (t.startsWith("{") || t.startsWith("[")) {
      try {
        return JSON.stringify(JSON.parse(t), null, 2);
      } catch {
        /* fall through — not JSON */
      }
    }
    return v;
  }
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

const indent = (s: string) => s.replace(/\n/g, "\n  ");

/** Outbound: a request WE sent to Meta + its response. `url` MUST be redacted. */
export function wireOut(
  method: string,
  url: string,
  reqBody: unknown,
  status: number,
  resBody: unknown,
): void {
  if (!ON) return;
  try {
    const ok = status >= 200 && status < 300;
    console.log(`\n\x1b[36m→ META ${method} ${url}\x1b[0m`);
    const rb = pretty(reqBody);
    if (rb) console.log(`  req ${indent(rb)}`);
    console.log(`  \x1b[${ok ? "32" : "31"}m← ${status}\x1b[0m ${indent(pretty(resBody))}`);
  } catch {
    /* never throw from a diagnostic */
  }
}

/** Inbound: a webhook Meta sent US (raw body). */
export function wireIn(label: string, rawBody: string): void {
  if (!ON) return;
  try {
    console.log(`\n\x1b[35m← WEBHOOK ${label}\x1b[0m`);
    console.log(`  ${indent(pretty(rawBody))}`);
  } catch {
    /* never throw from a diagnostic */
  }
}
