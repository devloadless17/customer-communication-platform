import { afterEach, describe, expect, it, vi } from "vitest";

import { SendInteractiveSchema } from "@/messages/messages.schemas";
import { ExternalSendInteractiveSchema } from "@/external/v1/external-v1.schemas";
import { metaProvider } from "@/lib/providers/meta";

/**
 * Interactive list messages (interactive-list-messages doc). Pinned:
 *
 *  - the wire shape incl. the NEW optional text header (≤60) + footer (≤60),
 *    emitted only when supplied;
 *  - the row-id cap SPLIT the doc revealed: LIST row ids cap at 200 (button
 *    reply ids stay 256). Enforced at authoring time on both mirrored
 *    schemas — the provider deliberately never truncates an id, because a
 *    truncated id silently breaks `list_reply.id` matching (the historical
 *    ask_question routing bug).
 */

const ROWS = [
  { id: "priority_express", title: "Priority Mail Express", description: "Next Day to 2 Days" },
  { id: "priority_mail", title: "Priority Mail" },
];

describe("schemas — the 200-char list row id cap (both mirrors)", () => {
  const base = { conversationId: "c1", body: "Which shipping option do you prefer?" };
  const longId = "x".repeat(201);

  it("accepts a 200-char list row id, rejects 201", () => {
    const ok = { ...base, kind: "list", options: [{ id: "x".repeat(200), title: "A" }] };
    const bad = { ...base, kind: "list", options: [{ id: longId, title: "A" }] };
    expect(SendInteractiveSchema.safeParse(ok).success).toBe(true);
    expect(SendInteractiveSchema.safeParse(bad).success).toBe(false);
    expect(
      ExternalSendInteractiveSchema.safeParse({ body: base.body, kind: "list", options: [{ id: longId, title: "A" }] }).success,
    ).toBe(false);
  });

  it("still allows BUTTON reply ids up to 256 (the caps are split by kind)", () => {
    const buttons = {
      ...base,
      kind: "buttons",
      options: [{ id: "x".repeat(256), title: "A" }],
    };
    expect(SendInteractiveSchema.safeParse(buttons).success).toBe(true);
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
        return new Response(JSON.stringify({ messages: [{ id: "wamid.LIST_1" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    await metaProvider.sendInteractive!(
      args as Parameters<NonNullable<typeof metaProvider.sendInteractive>>[0],
      { phoneNumberId: "pn_1", accessToken: "tok", graphVersion: "v26.0" } as Parameters<
        NonNullable<typeof metaProvider.sendInteractive>
      >[1],
    );
    return captured;
  }

  it("emits header + footer when supplied, in the doc's exact shape", async () => {
    const body = await capture({
      to: "96170000003",
      bodyText: "Which shipping option do you prefer?",
      kind: "list",
      options: ROWS,
      listCtaLabel: "Shipping Options",
      listSectionTitle: "I want it ASAP!",
      headerText: "Choose Shipping Option",
      footerText: "Lucky Shrub: Your gateway to succulents™",
    });
    expect(body).toMatchObject({
      type: "interactive",
      interactive: {
        type: "list",
        header: { type: "text", text: "Choose Shipping Option" },
        body: { text: "Which shipping option do you prefer?" },
        footer: { text: "Lucky Shrub: Your gateway to succulents™" },
        action: {
          button: "Shipping Options",
          sections: [
            {
              title: "I want it ASAP!",
              rows: [
                ROWS[0],
                { id: "priority_mail", title: "Priority Mail" },
              ],
            },
          ],
        },
      },
    });
  });

  it("reply BUTTONS take the same optional header/footer (reply-buttons doc)", async () => {
    const body = await capture({
      to: "96170000003",
      bodyText: "Use the buttons if you need to reschedule.",
      kind: "buttons",
      options: [
        { id: "change-button", title: "Change" },
        { id: "cancel-button", title: "Cancel" },
      ],
      headerText: "Workshop Details",
      footerText: "Lucky Shrub: Your gateway to succulents!™",
    });
    expect(body).toMatchObject({
      interactive: {
        type: "button",
        header: { type: "text", text: "Workshop Details" },
        footer: { text: "Lucky Shrub: Your gateway to succulents!™" },
        action: {
          buttons: [
            { type: "reply", reply: { id: "change-button", title: "Change" } },
            { type: "reply", reply: { id: "cancel-button", title: "Cancel" } },
          ],
        },
      },
    });
  });

  it("omits header/footer when absent (legacy shape byte-identical)", async () => {
    const body = await capture({
      to: "96170000003",
      bodyText: "Pick one",
      kind: "list",
      options: ROWS,
    });
    const interactive = body.interactive as Record<string, unknown>;
    expect(interactive.header).toBeUndefined();
    expect(interactive.footer).toBeUndefined();
    expect((interactive.action as { button: string }).button).toBe("Choose");
  });
});
