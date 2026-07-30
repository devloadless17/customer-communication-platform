import { createHmac, timingSafeEqual } from "node:crypto";

import { Body, Controller, HttpException, Logger, Post, UseGuards } from "@nestjs/common";

import { db } from "@/lib/db";
import { platformAppSecrets } from "@/lib/providers/app-level-webhook";
import { WebhookRateLimitGuard } from "../webhook-rate-limit.guard";

/**
 * Meta's DATA DELETION REQUEST CALLBACK.
 *
 * Meta requires this of every app that accesses user data: "Apps that access user
 * data must provide a way for users to request that their data be deleted", and
 * "Failure to comply with these requirements may result in your callback being
 * removed or your app being disabled." We store Messenger PSIDs and Instagram
 * IGSIDs, so it applies to us.
 *
 * Note the requirement is satisfiable TWO ways — Meta's own FAQ: "Developers need to
 * specify either a data deletion callback instruction URL or a callback URL found in
 * Basic Settings for your app." A static instructions page is enough on paper. This
 * endpoint is the stronger half: it actually acts on the request rather than telling
 * the user to email someone.
 *
 * ## The wire contract, exactly
 *
 * Meta POSTs `application/x-www-form-urlencoded` with a single `signed_request`
 * field shaped `<base64url signature>.<base64url payload>`. The signature is
 * `HMAC-SHA256(payload, app_secret)` over the payload **exactly as transmitted** —
 * the base64url STRING, not the decoded JSON. Decoding and re-encoding before
 * hashing is the classic way to break this. The decoded payload is
 * `{algorithm, expires, issued_at, user_id}` and we respond with
 * `{url, confirmation_code}`.
 *
 * ## Which secret verifies it
 *
 * The PLATFORM app secret only (`META_APP_SECRET`, comma-separated so a rotation
 * window works). The deletion callback URL is configured per APP in the App
 * Dashboard, so a tenant running their own Meta app configures their OWN URL and
 * their requests never arrive here. That is why this does not need — and must not
 * attempt — a scan of every tenant's app secret. With no platform secret configured
 * we REFUSE rather than accept unverified deletion instructions.
 *
 * ## The trap: `user_id` is an APP-scoped id, not the id we store
 *
 * Meta documents it as "an app-scoped ID identifying the user making the request"
 * (ASID). What we store on `Contact.externalContactId` is a PAGE-scoped id (PSID)
 * for Messenger, or an IGSID for Instagram. Those are DIFFERENT namespaces for the
 * same human, and mapping ASID → PSID needs `/{asid}/ids_for_pages`, which requires
 * a user token we do not hold at deletion time.
 *
 * So a direct match may find nothing, and that is not an error — it is the expected
 * case. This endpoint therefore does two separate things and never conflates them:
 * it ALWAYS acknowledges (which is what Meta requires and what the user is owed),
 * and it deletes whatever the id does match. Anything unmatched is logged at warning
 * with the id so an operator can complete the erasure by hand. Claiming a completed
 * deletion we did not perform would be worse than saying we are still working on it.
 *
 * ## What "delete" means here, and why
 *
 * The contact is TOMBSTONED (`deletedAt`), which is this product's own established
 * meaning of deleting a contact — see `ContactsService`, whose comment states it
 * outright: "Soft-delete: tombstone the contacts but PRESERVE conversations +
 * messages + media — a contact delete must not take its chat with it." A tombstoned
 * contact leaves the directory, search, CSV exports and audience counts, so we stop
 * processing them, while the workspace's own business record survives.
 *
 * That boundary is deliberate and is a POLICY choice, not a technical one: this
 * platform is a processor and the workspace is the controller, so erasing a
 * business's conversation history on an end user's request to US is not a call this
 * endpoint should make unilaterally. Full content erasure is an operator action, and
 * the warning log is what tells them a request is outstanding.
 */

/** Alphanumeric, stable for a given user id, and unguessable without the secret. */
function confirmationCodeFor(userId: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`data-deletion:${userId}`)
    .digest("hex")
    .slice(0, 16);
}

function base64UrlToBuffer(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

interface SignedRequestPayload {
  algorithm?: unknown;
  user_id?: unknown;
  issued_at?: unknown;
}

/**
 * Verify and decode, or return null. Tries every configured secret so a rotation
 * window does not reject real requests.
 */
function parseSignedRequest(
  signedRequest: string,
  secrets: string[],
): SignedRequestPayload | null {
  const dot = signedRequest.indexOf(".");
  if (dot <= 0) return null;
  const encodedSig = signedRequest.slice(0, dot);
  // The payload is hashed AS TRANSMITTED. Keep the original substring.
  const payload = signedRequest.slice(dot + 1);
  if (payload.length === 0) return null;

  const sig = base64UrlToBuffer(encodedSig);
  const verified = secrets.some((secret) => {
    const expected = createHmac("sha256", secret).update(payload).digest();
    // Length check first: timingSafeEqual throws on a mismatch rather than
    // returning false, which would turn a malformed signature into a 500.
    return sig.length === expected.length && timingSafeEqual(sig, expected);
  });
  if (!verified) return null;

  try {
    const json = JSON.parse(base64UrlToBuffer(payload).toString("utf8")) as SignedRequestPayload;
    // Meta states HMAC-SHA256. Anything else is not a shape we verified.
    if (typeof json.algorithm === "string" && json.algorithm.toUpperCase() !== "HMAC-SHA256") {
      return null;
    }
    return json;
  } catch {
    return null;
  }
}

@Controller("webhooks/meta-data-deletion")
// Public and unauthenticated, so it needs the same throttle the Meta webhook
// route has. This is the "future un-parameterized webhook route" that guard's
// own comment anticipates: with no `:workspaceId` to key on it falls back to the
// proxy-resolved IP bucket, which is the right scope here — real traffic is a
// handful of requests a month, so anything approaching the limit is a prober.
@UseGuards(WebhookRateLimitGuard)
export class MetaDataDeletionController {
  private readonly logger = new Logger(MetaDataDeletionController.name);

  /**
   * Sibling path to `webhooks/meta`, NOT a child of it. `@Controller("webhooks/meta")`
   * owns `@Post(":workspaceId")`, and a literal segment underneath it would be a
   * routing coin-flip against that wildcard depending on declaration order.
   */
  @Post()
  async handle(
    @Body() body: { signed_request?: unknown },
  ): Promise<{ url: string; confirmation_code: string }> {
    const secrets = platformAppSecrets();
    if (secrets.length === 0) {
      // Cannot verify ⇒ cannot act. Accepting an unverified deletion instruction
      // would let anyone tombstone any contact by guessing an id.
      this.logger.error(
        "[meta-data-deletion] refused: META_APP_SECRET is not configured, so no " +
          "request can be verified. Set it, or remove the Data Deletion Callback URL " +
          "from the App Dashboard and use an instructions URL instead.",
      );
      throw new HttpException({ error: "not_configured" }, 503);
    }

    const signedRequest = typeof body?.signed_request === "string" ? body.signed_request : null;
    if (!signedRequest) {
      throw new HttpException({ error: "missing_signed_request" }, 400);
    }

    const payload = parseSignedRequest(signedRequest, secrets);
    if (!payload) {
      // Deliberately terse to the caller and loud in our logs: an unverifiable
      // signature is either a misconfiguration or someone probing.
      this.logger.warn("[meta-data-deletion] rejected a signed_request that failed verification");
      throw new HttpException({ error: "bad_signature" }, 403);
    }

    const userId = typeof payload.user_id === "string" ? payload.user_id.trim() : "";
    if (!userId) {
      throw new HttpException({ error: "missing_user_id" }, 400);
    }

    // Tombstone every contact this id matches, on either Meta social channel and
    // across every workspace: the requester is one human, and we have no tenant
    // context here. `deletedAt: null` keeps this idempotent — Meta can and does
    // retry, and a second request must not churn timestamps.
    const affected = await db.contact.updateMany({
      where: {
        identityChannel: { in: ["messenger", "instagram"] },
        externalContactId: userId,
        deletedAt: null,
      },
      data: { deletedAt: new Date() },
    });

    // Always log, matched or not. A zero match is the EXPECTED outcome for an
    // app-scoped id (see the ASID/PSID note above), and it is the case that needs a
    // human — so it must not look like nothing happened.
    if (affected.count > 0) {
      this.logger.warn(
        JSON.stringify({
          event: "meta.data_deletion_request",
          severity: "warning",
          outcome: "contacts_tombstoned",
          count: affected.count,
          note: "Conversation history is preserved by design — see the controller docblock.",
        }),
      );
    } else {
      this.logger.warn(
        JSON.stringify({
          event: "meta.data_deletion_request",
          severity: "warning",
          outcome: "no_direct_match",
          note:
            "Verified request whose app-scoped id matched no stored PSID/IGSID. This is " +
            "expected — the namespaces differ. Needs manual follow-up to complete the erasure.",
        }),
      );
    }

    // Meta requires a URL, so an empty base (which would yield a bare path) is
    // not an option. Same dev fallback the workflow runner uses for its links —
    // prod always sets this (deploy.yml), and `packages/config` warns if it
    // still points at localhost there.
    const base = (process.env.APP_PUBLIC_URL || "http://localhost:3000").replace(/\/+$/, "");
    const code = confirmationCodeFor(userId, secrets[0]!);
    return {
      url: `${base}/privacy/data-deletion?code=${encodeURIComponent(code)}`,
      confirmation_code: code,
    };
  }
}
