/**
 * Every webhook field the social parser CONSUMES must also be SUBSCRIBED.
 *
 * Meta only delivers a Page webhook field the app is subscribed to for that Page
 * (`POST /{page-id}/subscribed_apps?subscribed_fields=…`). So a parser branch for
 * an unsubscribed field is unreachable code, and the feature behind it is dead —
 * silently, because nothing errors: Meta simply never sends the event.
 *
 * `meta-page-subscription.ts` states this rule ("Adding a parser branch for a new
 * field means adding it here, otherwise Meta never sends it") but nothing enforced
 * it, and `response_feedback` drifted: the parser produced `message_feedback` from
 * it, ingest patched `Message.feedback`, the UI rendered a Helpful/Not-helpful
 * chip — and the field was never in the subscription set, so none of it ever ran.
 * Meta's reference makes that doubly costly, since subscribing is also what puts
 * the 👍/👎 buttons in the customer's thread: unsubscribed, the customer never saw
 * the buttons either.
 *
 * This is a TRIPWIRE, in the same spirit as partial-indexes.spec.ts: the list below
 * is maintained by hand, and adding a parser branch means adding its field here.
 *
 *   pnpm --filter @ccp/api exec vitest run test/page-subscription-coverage.spec.ts
 */
import { describe, expect, it } from "vitest";

import {
  PAGE_MESSAGING_FIELDS,
  PAGE_OPTIONAL_FIELDS,
} from "@/lib/providers/meta-page-subscription";

/**
 * Page webhook fields `meta-social.ts` has a parse branch for, and what breaks if
 * the field is not subscribed. Keep in lockstep with the parser.
 */
const PARSER_CONSUMES: ReadonlyArray<{ field: string; branch: string }> = [
  { field: "messages", branch: "inbound text / media / attachments" },
  { field: "message_echoes", branch: "replies typed in Meta's native Page inbox" },
  { field: "message_deliveries", branch: "delivery watermark → delivered ticks" },
  { field: "message_reads", branch: "Messenger read watermark → Seen" },
  // `messaging_seen` was listed here as "Instagram read receipt (IG has no
  // message_reads)". Both halves are wrong, per `list_topics` on 2026-07-30: it is
  // NOT one of the `page` topic's 69 fields (which DO include `message_reads`), and
  // it belongs to the separate app-level `instagram` topic. Subscribing a Page to
  // it achieved nothing and risked the optional POST being rejected wholesale.
  //
  // IG read receipts really do arrive on `entry.messaging[].read`, but the gate is
  // the app-level `instagram` topic subscription — not a `subscribed_apps` field —
  // so it is outside this test's scope by construction.
  { field: "message_reactions", branch: "emoji reaction on a message" },
  // Both channels ship an edit webhook, under different names: `page` has
  // `message_edits` (plural), `instagram` has `message_edit` (singular).
  { field: "message_edits", branch: "customer edited a message" },
  {
    field: "call_permission_reply",
    branch: "customer's answer to a Messenger call-permission request",
  },
  { field: "messaging_postbacks", branch: "Get Started / persistent menu / button taps" },
  { field: "messaging_referrals", branch: "m.me ref links + Click-to-Messenger attribution" },
  { field: "messaging_optins", branch: "opt-in / notification tokens" },
  { field: "response_feedback", branch: "Messenger 👍/👎 rating of a business message" },
  { field: "calls", branch: "Messenger Calling lifecycle (entry.calls[])" },
];

describe("page webhook subscription coverage", () => {
  const subscribed = new Set<string>([
    ...(PAGE_MESSAGING_FIELDS as readonly string[]),
    ...(PAGE_OPTIONAL_FIELDS as readonly string[]),
  ]);

  it("subscribes every field the parser has a branch for", () => {
    const unsubscribed = PARSER_CONSUMES.filter((f) => !subscribed.has(f.field));
    expect(
      unsubscribed,
      `these parser branches can never fire — Meta only delivers subscribed fields:\n` +
        unsubscribed.map((f) => `  ${f.field} → ${f.branch}`).join("\n"),
    ).toEqual([]);
  });

  it("keeps `messages` in the REQUIRED set — losing it loses all inbound", () => {
    // The optional set is allowed to fail (a missing permission rejects the whole
    // POST, so we retry with the core set). `messages` must never be demoted into
    // it: that trade is "lose a read receipt" vs "lose every message".
    expect(PAGE_MESSAGING_FIELDS as readonly string[]).toContain("messages");
    expect(PAGE_OPTIONAL_FIELDS as readonly string[]).not.toContain("messages");
  });

  it("keeps the two sets disjoint", () => {
    // A field in both would be reported missing by one code path and satisfied by
    // the other — the settings-page warning would flicker on a healthy Page.
    const overlap = (PAGE_MESSAGING_FIELDS as readonly string[]).filter((f) =>
      (PAGE_OPTIONAL_FIELDS as readonly string[]).includes(f),
    );
    expect(overlap).toEqual([]);
  });
});
