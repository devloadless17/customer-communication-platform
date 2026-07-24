/**
 * Transactional email — verification codes and invites.
 *
 * ONE seam, deliberately small. Two callers, and they live in DIFFERENT
 * processes — the signup OTP is sent by the Next.js side (Better Auth owns
 * /api/auth/*) and the invite by NestJS. That is precisely why this sits in
 * @ccp/shared: a copy in each app is how the two drift into different From
 * addresses, different timeouts, and one of them quietly not working.
 *
 * Framework-agnostic on purpose — a `fetch` and two env reads, no Nest, no
 * Prisma — so both runtimes can import it unchanged.
 *
 * TWO TRANSPORTS, chosen by which credential is present — because Brevo issues
 * two different ones and they are NOT interchangeable:
 *
 *   · `BREVO_API_KEY`  (`xkeysib-…`)  → HTTP POST to api.brevo.com. PREFERRED:
 *     it works from a container with only outbound 443.
 *   · `MAIL_SMTP_*`    (`xsmtpsib-…`) → SMTP relay on port 587.
 *
 * HTTP wins when both are set. SMTP needs egress on 587, which a lot of hosts
 * (and most serverless platforms) block — and the failure mode is a HANG, not an
 * error, so it looks like the app is slow rather than misconfigured. Keeping
 * both means an operator handed either credential is unblocked immediately, and
 * a deployment that later hits a blocked port fixes it by adding an API key
 * rather than by changing code.
 *
 * WHY THIS THROWS. Everywhere else in this codebase a non-critical read degrades
 * quietly (see `soft()` in apps/web). Mail is the opposite: a verification email
 * that silently fails leaves someone staring at a code entry box for a message
 * that is never coming, with no way to tell whether to wait or retry. The caller
 * must be able to say "we couldn't send it — try again".
 */

const BREVO_ENDPOINT = "https://api.brevo.com/v3/smtp/email";

/** Brevo rejects a send that takes too long anyway; fail fast rather than hold a request open. */
const SEND_TIMEOUT_MS = 10_000;

export class MailSendError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "MailSendError";
  }
}

export interface SendMailArgs {
  to: string;
  subject: string;
  /** Rendered HTML body. */
  html: string;
  /**
   * Plain-text alternative. NOT optional by accident: a message with no text
   * part scores worse with spam filters and is unreadable in clients that
   * refuse HTML, which is exactly the audience most likely to be on a corporate
   * mail gateway.
   */
  text: string;
}

/**
 * True when we have no provider configured and should log instead of send.
 *
 * Without this every developer needs a Brevo key before they can complete a
 * signup locally, and the e2e suites would send real mail to made-up addresses
 * on every run — which is both wasteful and a fast route to a damaged sending
 * reputation.
 */
export function mailIsStubbed(): boolean {
  return mailTransport() === "stub";
}

/**
 * Are we inside a test run?
 *
 * A HARD interlock, not a convention. Brevo's free tier is 300 sends a day and
 * they are the customer's, not the suite's — one accidentally-unmocked test
 * looping over a fixture can spend the lot and, worse, deliver junk to real
 * addresses from a live domain, which damages the sending reputation the SPF
 * and DKIM records exist to build.
 *
 * Relying on every test to mock `fetch` is exactly the sort of promise that
 * holds until the day someone adds a test that forgets. Checking the runner
 * here means a test CANNOT send, however it is written.
 */
function isTestRun(): boolean {
  return (
    process.env.NODE_ENV === "test" ||
    // Set by vitest in every worker.
    Boolean(process.env.VITEST) ||
    // Playwright sets neither, so the e2e harness opts in explicitly.
    process.env.MAIL_DISABLE_SEND === "1"
  );
}

/**
 * Which transport a send would use, from configuration ALONE.
 *
 * Deliberately not gated by `isTestRun()`: this answers "is mail wired up
 * correctly", and a test that cannot ask that question cannot verify the
 * wiring. `sendMail` applies the test interlock separately, so reporting
 * "smtp" here never means a test can actually send.
 */
export function mailTransport(): "http" | "smtp" | "stub" {
  if (process.env.BREVO_API_KEY) return "http";
  if (process.env.MAIL_SMTP_HOST) return "smtp";
  return "stub";
}

/**
 * Reject a credential that cannot possibly work, by shape.
 *
 * Split out of `sendMail` so it is reachable without a send: Brevo hands out
 * `xkeysib-` (HTTP) and `xsmtpsib-` (SMTP) on the same settings page, they look
 * alike, and the HTTP endpoint answers `401 Key not found` — an error naming
 * neither the cause nor the fix.
 */
export function assertUsableMailCredentials(): void {
  const apiKey = process.env.BREVO_API_KEY;
  if (apiKey?.startsWith("xsmtpsib-")) {
    throw new MailSendError(
      "BREVO_API_KEY holds an SMTP key (xsmtpsib-…), which the HTTP API rejects. " +
        "Either set MAIL_SMTP_HOST/USER/PASSWORD to use it over SMTP, or generate " +
        "an API key (xkeysib-…) in Brevo under SMTP & API → API Keys.",
    );
  }
}

export async function sendMail(args: SendMailArgs): Promise<void> {
  const apiKey = process.env.BREVO_API_KEY;
  const fromEmail = process.env.MAIL_FROM;
  const fromName = process.env.MAIL_FROM_NAME ?? "Loadless";
  const smtpHost = process.env.MAIL_SMTP_HOST;

  // Interlock first, before any credential is read: nothing a test does can
  // reach a provider. See isTestRun().
  if (isTestRun()) {
    console.warn(
      `[mail:test] suppressed — no provider call. to=${args.to} ` +
        `subject=${JSON.stringify(args.subject)}\n${args.text}`,
    );
    return;
  }

  assertUsableMailCredentials();

  if (fromEmail && !apiKey && smtpHost) {
    await sendViaSmtp(args, { fromEmail, fromName, host: smtpHost });
    return;
  }

  if (!apiKey || !fromEmail) {
    // DEV FALLBACK. The body is logged in full — including the OTP — because
    // the whole point is that a local signup stays completable without a
    // provider account. `packages/config` makes these vars prod-required, so
    // this branch cannot silently swallow mail in production.
    console.warn(
      `[mail:stub] no BREVO_API_KEY/MAIL_FROM — not sending. ` +
        `to=${args.to} subject=${JSON.stringify(args.subject)}\n${args.text}`,
    );
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(BREVO_ENDPOINT, {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        sender: { email: fromEmail, name: fromName },
        to: [{ email: args.to }],
        subject: args.subject,
        htmlContent: args.html,
        textContent: args.text,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    // Abort (timeout) and network failure land here identically from the
    // caller's point of view: the mail did not go.
    throw new MailSendError(
      `mail send failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // Brevo returns a JSON body with a `message`; include it — "400" alone
    // tells an operator nothing about whether the domain is unverified, the
    // key is wrong, or the daily cap is spent.
    const detail = await res.text().catch(() => "");
    throw new MailSendError(
      `mail send rejected (${res.status}): ${detail.slice(0, 300)}`,
      res.status,
    );
  }
}


/**
 * SMTP transport. Used when only SMTP credentials are configured.
 *
 * A fresh connection per send rather than a pooled transporter: this app sends a
 * handful of messages a day (signup codes and invites), so pooling would buy
 * nothing and cost a socket to drain on shutdown — which is exactly the class of
 * bug that produced 28 "pool after end" errors elsewhere in this codebase.
 */
async function sendViaSmtp(
  args: SendMailArgs,
  cfg: { fromEmail: string; fromName: string; host: string },
): Promise<void> {
  const user = process.env.MAIL_SMTP_USER;
  // `BREVO_SMTP_KEY` is accepted as an alias because that is what Brevo's own
  // settings page calls it, and an operator copying from that screen should not
  // have to know our variable naming to get mail working.
  const pass = process.env.MAIL_SMTP_PASSWORD ?? process.env.BREVO_SMTP_KEY;
  if (!user || !pass) {
    throw new MailSendError(
      "MAIL_SMTP_HOST is set but MAIL_SMTP_USER and MAIL_SMTP_PASSWORD " +
        "(or BREVO_SMTP_KEY) are missing.",
    );
  }

  // Imported lazily so the HTTP path — and every process that never sends mail —
  // does not pay to load it.
  const { createTransport } = await import("nodemailer");
  const port = Number(process.env.MAIL_SMTP_PORT ?? 587);

  try {
    await createTransport({
      host: cfg.host,
      port,
      // 587 is STARTTLS: connect in clear, upgrade. `secure: true` is for 465
      // and would hang against 587 — a wrong value here fails as a timeout, not
      // an error, which is the hardest kind of misconfiguration to diagnose.
      secure: port === 465,
      auth: { user, pass },
      connectionTimeout: SEND_TIMEOUT_MS,
      greetingTimeout: SEND_TIMEOUT_MS,
      socketTimeout: SEND_TIMEOUT_MS,
    }).sendMail({
      from: { address: cfg.fromEmail, name: cfg.fromName },
      to: args.to,
      subject: args.subject,
      html: args.html,
      text: args.text,
    });
  } catch (err) {
    throw new MailSendError(
      `smtp send failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
