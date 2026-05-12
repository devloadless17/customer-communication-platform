import { randomBytes } from "node:crypto";

import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import { invalidateProviderConfig } from "@/lib/providers/config";

/**
 * Admin-only: connect / update the team's WhatsApp Cloud API credentials.
 *
 * Body: `{ phoneNumberId, accessToken, appSecret, verifyToken? }`. The
 * verifyToken is optional — if omitted we generate a strong default the
 * admin pastes into Meta's dashboard.
 *
 * Validation:
 *   1) Hit Meta's `/{phone_number_id}` endpoint with the access token. This
 *      catches most paste mistakes (wrong id, wrong token, expired token)
 *      before we save anything. The display number Meta returns is stored
 *      so the settings page can show "+1 555…" without re-fetching.
 *   2) The phoneNumberId is unique across teams (DB constraint), so a typo
 *      that lands on someone else's number is rejected at write.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  phoneNumberId?: unknown;
  accessToken?: unknown;
  appSecret?: unknown;
  verifyToken?: unknown;
  wabaId?: unknown;
}

const GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? "v25.0";

export async function POST(req: Request) {
  const session = await requireAdmin();
  if (session instanceof NextResponse) return session;

  let raw: Body;
  try {
    raw = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const phoneNumberId = strField(raw.phoneNumberId);
  const accessToken = strField(raw.accessToken);
  const appSecret = strField(raw.appSecret);
  const providedVerifyToken = strField(raw.verifyToken);
  // Optional at first connect — admin can paste it later when they want
  // template features. Empty string means "clear it" so an admin can drop a
  // wrong id without disconnecting the whole integration.
  const wabaIdInput = raw.wabaId === undefined ? undefined : strField(raw.wabaId);

  if (!phoneNumberId || !accessToken || !appSecret) {
    return NextResponse.json(
      { error: "phoneNumberId, accessToken, and appSecret are required" },
      { status: 400 },
    );
  }

  // Validate against Meta — the cheapest call that proves the token can act
  // on this phone number id is GET /{phone-number-id}.
  //
  // Field choice: `whatsapp_business_account_id` is NOT a field on the phone
  // number node and asking for it makes Meta reject the entire request with
  // (#100) "Tried accessing nonexisting field". WABA isn't needed for send
  // or webhook receive; we'll fetch/store it later when template management
  // lands. Keep this call to fields the phone number node actually exposes.
  let displayNumber: string | undefined;
  try {
    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name`,
      { headers: { authorization: `Bearer ${accessToken}` } },
    );
    if (!res.ok) {
      const body = await res.text();
      return NextResponse.json(
        { error: "meta rejected credentials", status: res.status, detail: body.slice(0, 500) },
        { status: 400 },
      );
    }
    const data = (await res.json()) as { display_phone_number?: string };
    displayNumber = data.display_phone_number;
  } catch (err) {
    console.error("[api/team/whatsapp] meta validation failed", err);
    return NextResponse.json(
      { error: "could not reach meta to validate", detail: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }

  const verifyToken = providedVerifyToken || randomBytes(24).toString("hex");

  try {
    await db.team.update({
      where: { id: session.teamId },
      data: {
        metaPhoneNumberId: phoneNumberId,
        metaAccessToken: accessToken,
        metaAppSecret: appSecret,
        metaVerifyToken: verifyToken,
        metaDisplayPhoneNumber: displayNumber ?? null,
        // wabaId is supplied by the admin (from WhatsApp Manager) so we can
        // hit `/{waba-id}/message_templates`. Passing the field at all means
        // "update" — explicit empty string clears it; undefined leaves the
        // current value intact.
        ...(wabaIdInput === undefined
          ? {}
          : { metaWabaId: wabaIdInput || null }),
      },
    });
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "P2002"
    ) {
      return NextResponse.json(
        { error: "this phone number id is already connected to another team" },
        { status: 409 },
      );
    }
    throw err;
  }

  // Bust the in-process credential cache so the next webhook / send picks up
  // the new values immediately instead of waiting out the TTL.
  invalidateProviderConfig(session.teamId);

  return NextResponse.json({
    ok: true,
    config: {
      phoneNumberId,
      displayNumber: displayNumber ?? null,
      verifyToken,
    },
  });
}

/**
 * Admin-only: disconnect the team from Meta. Wipes credentials but leaves
 * historical messages intact (rule #2 — multi-tenancy means we don't lose
 * audit trail when an integration toggles).
 */
export async function DELETE() {
  const session = await requireAdmin();
  if (session instanceof NextResponse) return session;

  await db.team.update({
    where: { id: session.teamId },
    data: {
      metaPhoneNumberId: null,
      metaAccessToken: null,
      metaAppSecret: null,
      metaVerifyToken: null,
      metaDisplayPhoneNumber: null,
      metaWabaId: null,
    },
  });
  invalidateProviderConfig(session.teamId);
  return NextResponse.json({ ok: true });
}

function strField(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
