import { afterEach, describe, expect, it, vi } from "vitest";

import { SendInteractiveSchema } from "@/messages/messages.schemas";
import { ExternalSendInteractiveSchema } from "@/external/v1/external-v1.schemas";
import { metaProvider } from "@/lib/providers/meta";
import { CHANNEL_CAPABILITIES } from "@ccp/shared/providers/capabilities";

/**
 * Interactive CTA URL button messages (cta-url-messages doc): one button that
 * opens a URL so the raw link never appears in the body. Wire:
 *
 *   interactive: { type: "cta_url", header?, body, footer?,
 *                  action: { name: "cta_url",
 *                            parameters: { display_text (≤20), url } } }
 *
 * Pinned: the exact wire (incl. optional text header/footer emission and the
 * 20/60/60 truncations), and the mirrored schema rules — `ctaUrl` required
 * iff kind is cta_url, no authored options, http(s) URLs only.
 */

const CTA = { displayText: "See Dates", url: "https://example.com/dates?x=1" };

describe("schemas (composer + /v1 mirror)", () => {
  const base = { conversationId: "c1", body: "Tap below to see dates." };

  it("accepts cta_url with ctaUrl and no options on both schemas", () => {
    expect(
      SendInteractiveSchema.safeParse({ ...base, kind: "cta_url", ctaUrl: CTA }).success,
    ).toBe(true);
    expect(
      ExternalSendInteractiveSchema.safeParse({
        body: base.body,
        kind: "cta_url",
        ctaUrl: CTA,
      }).success,
    ).toBe(true);
  });

  it("rejects cta_url without ctaUrl, with options, or with a non-http(s) URL", () => {
    expect(SendInteractiveSchema.safeParse({ ...base, kind: "cta_url" }).success).toBe(false);
    expect(
      SendInteractiveSchema.safeParse({
        ...base,
        kind: "cta_url",
        ctaUrl: CTA,
        options: [{ id: "a", title: "A" }],
      }).success,
    ).toBe(false);
    expect(
      SendInteractiveSchema.safeParse({
        ...base,
        kind: "cta_url",
        ctaUrl: { displayText: "Open", url: "ftp://example.com/x" },
      }).success,
    ).toBe(false);
  });

  it("rejects ctaUrl on non-cta kinds (both schemas)", () => {
    expect(
      SendInteractiveSchema.safeParse({
        ...base,
        kind: "buttons",
        options: [{ id: "a", title: "A" }],
        ctaUrl: CTA,
      }).success,
    ).toBe(false);
    expect(
      ExternalSendInteractiveSchema.safeParse({
        body: base.body,
        kind: "list",
        options: [{ id: "a", title: "A" }],
        ctaUrl: CTA,
      }).success,
    ).toBe(false);
  });

  it("is capability-gated to WhatsApp", () => {
    expect(CHANNEL_CAPABILITIES.whatsapp.ctaUrlButton).toBe(true);
    expect(CHANNEL_CAPABILITIES.messenger.ctaUrlButton).toBeUndefined();
    expect(CHANNEL_CAPABILITIES.instagram.ctaUrlButton).toBeUndefined();
  });
});

describe("provider wire shape", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function capture(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    let captured: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: { body?: string }) => {
        captured = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
        return new Response(JSON.stringify({ messages: [{ id: "wamid.CTA_1" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    await metaProvider.sendInteractive!(
      args as Parameters<NonNullable<typeof metaProvider.sendInteractive>>[0],
      { phoneNumberId: "pn_1", accessToken: "tok", graphVersion: "v25.0" } as Parameters<
        NonNullable<typeof metaProvider.sendInteractive>
      >[1],
    );
    return captured;
  }

  it("posts the exact cta_url shape with header + footer when supplied", async () => {
    const body = await capture({
      to: "96170000002",
      bodyText: "Tap the button below to see available dates.",
      kind: "cta_url",
      options: [],
      ctaUrl: {
        ...CTA,
        headerText: "New workshop dates announced!",
        footerText: "Dates subject to change.",
      },
    });
    expect(body).toMatchObject({
      type: "interactive",
      interactive: {
        type: "cta_url",
        header: { type: "text", text: "New workshop dates announced!" },
        body: { text: "Tap the button below to see available dates." },
        action: { name: "cta_url", parameters: { display_text: "See Dates", url: CTA.url } },
        footer: { text: "Dates subject to change." },
      },
    });
  });

  it("omits header/footer when absent and truncates display_text to 20", async () => {
    const body = await capture({
      to: "96170000002",
      bodyText: "Tap below.",
      kind: "cta_url",
      options: [],
      ctaUrl: { displayText: "A label far longer than twenty characters", url: CTA.url },
    });
    const interactive = body.interactive as Record<string, unknown>;
    expect(interactive.header).toBeUndefined();
    expect(interactive.footer).toBeUndefined();
    expect(
      (interactive.action as { parameters: { display_text: string } }).parameters
        .display_text,
    ).toHaveLength(20);
  });
});
