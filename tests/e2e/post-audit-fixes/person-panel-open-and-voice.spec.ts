import { test, expect } from "@playwright/test";

import { appAdmin, db } from "../_helpers/db";

/**
 * Two inbox defects reported by the maintainer on 2026-08-19.
 *
 * 1. "Open" in the person panel ("Same person") moved you to the other channel's
 *    thread sometimes, and did nothing at all other times — ten clicks, nothing.
 *    It was a `<Link href="/inbox?c=…">`, and the shell mirrors chat switches
 *    with `history.replaceState`, which the Next router and the RSC props never
 *    see. So after any in-app switch the SSR'd `?c=` still held the last
 *    NAVIGATED id, and the shell only re-syncs when that value CHANGES — making
 *    a link back to that same conversation permanently inert.
 *
 *    NOTE FOR ANYONE EDITING THIS: asserting on the URL proves nothing. An <a>
 *    updates the address bar whether or not the shell reacts, and an
 *    earlier version of this test passed against the BROKEN code for exactly
 *    that reason. Assert on rendered thread content.
 *
 * 2. The voice recorder's bar appeared the instant `MediaRecorder.start()`
 *    returned, so it invited the agent to talk before the microphone was
 *    actually delivering samples and the opening words were missing from the
 *    clip. The bar now waits for the encoder's first real chunk.
 */
const PREFIX = "e2e_zzv_";

let workspaceId: string;
let convA: string;
let convB: string;
const NAME_A = `${PREFIX}Wafa`;
const NAME_B = `${PREFIX}Rami`;

const cParam = (url: string) => new URL(url).searchParams.get("c");

// Fake mic for the voice test; harmless for the others. Must be top-level —
// launchOptions forces a new worker and Playwright refuses it inside describe.
test.use({
  launchOptions: {
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  },
  permissions: ["microphone"],
});

test.beforeAll(async () => {
  const admin = await appAdmin();
  workspaceId = admin.workspaceId;

  // ONE person on TWO channels — the shape the person panel's switcher exists
  // for, and the only shape in which the "Open" control renders at all.
  const customer = await db().customer.create({
    data: { workspaceId, name: `${PREFIX}Nadia Haddad` },
  });
  const stamp = Date.now().toString().slice(-9);

  const a = await db().contact.create({
    data: {
      workspaceId,
      customerId: customer.id,
      name: NAME_A,
      phoneNumber: `+97${stamp}`,
      identityChannel: "whatsapp",
      // The composer derives the 24h send window from this denormalized
      // column, not from the message rows — without it the mic is disabled.
      lastInboundAt: new Date(),
    },
  });
  const b = await db().contact.create({
    data: {
      workspaceId,
      customerId: customer.id,
      name: NAME_B,
      externalContactId: `${PREFIX}ig_${stamp}`,
      identityChannel: "instagram",
      lastInboundAt: new Date(),
    },
  });

  for (const [contact, channel] of [
    [a, "whatsapp"] as const,
    [b, "instagram"] as const,
  ]) {
    const conv = await db().conversation.create({
      data: { workspaceId, contactId: contact.id, channel, status: "open" },
    });
    if (channel === "whatsapp") convA = conv.id;
    else convB = conv.id;
    await db().message.create({
      data: {
        workspaceId,
        conversationId: conv.id,
        externalId: `${PREFIX}${conv.id}_0`,
        body: `${PREFIX}hello from ${channel}`,
        direction: "in",
        channel,
        timestamp: new Date(Date.now() - 60_000),
      },
    });
  }
});

test.afterAll(async () => {
  await db().message.deleteMany({ where: { workspaceId, externalId: { startsWith: PREFIX } } });
  await db().conversation.deleteMany({ where: { workspaceId, id: { in: [convA, convB] } } });
  await db().contact.deleteMany({ where: { workspaceId, name: { startsWith: PREFIX } } });
  await db().customer.deleteMany({ where: { workspaceId, name: { startsWith: PREFIX } } });
});

test("person-panel Open switches threads even when the target IS the last navigated id", async ({
  page,
}) => {
  // Arm the exact failure state: a REAL navigation makes B the SSR'd
  // conversation, so the shell records B as its last synced id.
  await page.goto(`/inbox?c=${convB}`);
  await expect.poll(() => cParam(page.url()), { timeout: 30_000 }).toBe(convB);

  // Switch to A through the LIST — a pure client-side switch that only
  // replaceState's the URL, leaving the SSR'd id at B.
  await page.getByText(NAME_A).first().click();
  await expect.poll(() => cParam(page.url()), { timeout: 20_000 }).toBe(convA);
  await expect(page.getByText(`${PREFIX}hello from whatsapp`).first()).toBeVisible({
    timeout: 20_000,
  });

  // Click Open for B. The target now equals the last synced id, which is
  // precisely the state in which the old <Link> could never re-fire.
  const open = page.getByRole("button", { name: /^Open .*chat$/i }).first();
  await expect(open).toBeVisible({ timeout: 15_000 });
  await open.click();

  await expect.poll(() => cParam(page.url()), { timeout: 20_000 }).toBe(convB);
  // THE actual assertion: the thread really switched. The URL alone proves
  // nothing — an <a> changes it whether or not the shell reacts, which is
  // exactly how this defect hid.
  await expect(page.getByText(`${PREFIX}hello from instagram`).first()).toBeVisible({
    timeout: 20_000,
  });
});

test("the recording bar only appears once audio is really flowing", async ({ page }) => {
  await page.goto(`/inbox?c=${convA}`);
  const mic = page.getByRole("button", { name: "Record voice message" });
  await expect(mic).toBeVisible({ timeout: 30_000 });

  const t0 = Date.now();
  await mic.click();
  const discard = page.getByRole("button", { name: "Discard recording" });
  await expect(discard).toBeVisible({ timeout: 10_000 });
  const revealMs = Date.now() - t0;
  console.log(`[voice] bar revealed after ${revealMs}ms`);
  // Gated on the encoder's first real chunk, so it cannot be instant — and it
  // must still feel immediate.
  expect(revealMs).toBeGreaterThan(50);
  expect(revealMs).toBeLessThan(4000);

  await discard.click();
  await expect(discard).toBeHidden({ timeout: 10_000 });

  // Again, with the microphone already warm — isolates the one-off device-open
  // cost from the reveal wait this fix actually adds.
  const t1 = Date.now();
  await mic.click();
  await expect(discard).toBeVisible({ timeout: 10_000 });
  console.log(`[voice] second reveal after ${Date.now() - t1}ms`);
  await discard.click();
  await expect(discard).toBeHidden({ timeout: 10_000 });
});
