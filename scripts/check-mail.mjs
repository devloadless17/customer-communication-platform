#!/usr/bin/env node
/**
 * Diagnose outbound email WITHOUT sending anything.
 *
 *   pnpm mail:check
 *
 * Why this exists: a broken mail config is invisible from inside the app. The
 * OTP screen looks identical whether the message was delivered, silently
 * stubbed, or refused by the provider — the user just sits there waiting. This
 * answers the question in one command, and it is safe to run repeatedly because
 * it never sends: SMTP stops after AUTH (`verify()`), and the HTTP path reads
 * `GET /v3/account`. Neither touches the daily quota.
 *
 * The failure it was written for: Brevo answers
 *
 *     525 5.7.1 Unauthorized IP address
 *
 * when the sending machine's IP is not on the SMTP key's allowlist. That is
 * environmental, not transient, and no amount of retrying fixes it — but from
 * the app it looks exactly like a flaky send.
 */
import { createRequire } from "node:module";

// Anchored at packages/shared, which is where `nodemailer` is DECLARED. pnpm's
// node_modules is strict, so a require from the repo root cannot see a
// workspace package's dependency — resolving from here is what makes this
// script runnable from the root.
const require = createRequire(new URL("../packages/shared/package.json", import.meta.url));

try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch {
  console.log("note: no .env found — reading the ambient environment only\n");
}

const has = (v) => Boolean(process.env[v] && process.env[v].trim());
const apiKey = process.env.BREVO_API_KEY?.trim();
const smtpHost = process.env.MAIL_SMTP_HOST?.trim();
const from = process.env.MAIL_FROM?.trim();

console.log("Mail configuration");
console.log("  MAIL_FROM           ", from || "(unset)");
console.log("  MAIL_FROM_NAME      ", process.env.MAIL_FROM_NAME?.trim() || "(unset)");
console.log("  BREVO_API_KEY       ", apiKey ? `${apiKey.slice(0, 9)}… (${apiKey.length} chars)` : "(unset)");
console.log("  MAIL_SMTP_HOST      ", smtpHost || "(unset)");
console.log("  MAIL_SMTP_USER      ", process.env.MAIL_SMTP_USER?.trim() || "(unset)");
console.log(
  "  MAIL_SMTP_PASSWORD  ",
  has("MAIL_SMTP_PASSWORD") ? `set (${process.env.MAIL_SMTP_PASSWORD.length} chars)` : "(unset)",
);

// Mirrors `mailTransport()` in @ccp/shared/mail/send — HTTP wins when both are
// present, because it only needs outbound 443 and is not IP-restricted.
const transport = apiKey ? "http" : smtpHost ? "smtp" : "stub";
console.log(`\nActive transport: ${transport}`);

if (transport === "stub") {
  console.log(
    "\n✖ Nothing is configured, so NO EMAIL IS SENT — codes are only written to\n" +
      "  the server log. Set BREVO_API_KEY (preferred) or the MAIL_SMTP_* group.",
  );
  process.exit(1);
}

if (!from) {
  console.log("\n✖ MAIL_FROM is unset. Brevo rejects a send with no verified sender.");
  process.exit(1);
}

// An SMTP key pasted into BREVO_API_KEY is a real, easy mistake: both come from
// the same Brevo screen and only the prefix distinguishes them.
if (apiKey && apiKey.startsWith("xsmtpsib-")) {
  console.log(
    "\n✖ BREVO_API_KEY holds an SMTP key (xsmtpsib-…), not an HTTP API key\n" +
      "  (xkeysib-…). Those are not interchangeable. Either put this value in\n" +
      "  MAIL_SMTP_PASSWORD, or create an API key under Brevo → SMTP & API → API Keys.",
  );
  process.exit(1);
}

if (transport === "http") {
  const res = await fetch("https://api.brevo.com/v3/account", {
    headers: { "api-key": apiKey, accept: "application/json" },
  }).catch((e) => ({ ok: false, status: 0, _err: String(e.message) }));

  if (!res.ok) {
    const body = typeof res.text === "function" ? await res.text().catch(() => "") : res._err;
    console.log(`\n✖ Brevo API rejected the key (${res.status}): ${String(body).slice(0, 200)}`);
    process.exit(1);
  }
  const acct = await res.json();
  console.log("\n✔ Brevo HTTP API key is valid. No email was sent.");
  console.log(`  account: ${acct.email ?? "(unknown)"}`);
  const plan = Array.isArray(acct.plan) ? acct.plan[0] : undefined;
  if (plan) console.log(`  plan:    ${plan.type ?? "?"} · credits left: ${plan.credits ?? "?"}`);
  process.exit(0);
}

// SMTP: connect + AUTH, then stop. Never sends.
let nodemailer;
try {
  nodemailer = require("nodemailer");
} catch {
  console.log("\n✖ nodemailer is not resolvable from the repo root. Run: pnpm install");
  process.exit(1);
}

const t = nodemailer.createTransport({
  host: smtpHost,
  port: Number(process.env.MAIL_SMTP_PORT ?? 587),
  secure: false,
  auth: { user: process.env.MAIL_SMTP_USER, pass: process.env.MAIL_SMTP_PASSWORD },
  connectionTimeout: 15_000,
  greetingTimeout: 15_000,
});

try {
  await t.verify();
  console.log("\n✔ SMTP connect + AUTH succeeded. No email was sent.");
  process.exit(0);
} catch (err) {
  console.log(`\n✖ SMTP failed: ${err.code ?? "?"} ${err.response ?? err.message ?? ""}`);
  if (String(err.response ?? "").includes("Unauthorized IP")) {
    let ip = "your machine's public IP";
    try {
      ip = (await (await fetch("https://api.ipify.org")).text()).trim();
    } catch {
      /* offline — the guidance below still stands */
    }
    console.log(
      `\n  Brevo restricts SMTP keys by IP, and ${ip} is not on the allowlist.\n` +
        "  Two ways out:\n" +
        `    1. Allowlist it: Brevo → SMTP & API → (key) → Authorized IPs. Note that a\n` +
        "       home/office IP usually changes, so this tends to break again.\n" +
        "    2. PREFERRED — switch to the HTTP API: create an xkeysib-… key under\n" +
        "       Brevo → SMTP & API → API Keys and set BREVO_API_KEY. It is not\n" +
        "       IP-restricted and needs only outbound 443, so it works from this box\n" +
        "       and from the VPS with no allowlist to maintain. The app prefers HTTP\n" +
        "       automatically once that variable is set — no code change.",
    );
  }
  process.exit(1);
}
