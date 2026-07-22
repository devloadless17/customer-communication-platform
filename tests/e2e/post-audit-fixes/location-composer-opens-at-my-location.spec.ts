/**
 * The "Send a location" composer must open ON THE AGENT'S LOCATION, not on a
 * wide world view that later jumps.
 *
 * The original implementation asked for `{ enableHighAccuracy: true }` with no
 * `maximumAge` — which defaults to 0 and therefore FORBIDS the browser from
 * reusing a position it already has, forcing a fresh GPS acquisition on every
 * single open. The map sat on a default centre (with a confident red pin over
 * it) for seconds and then snapped elsewhere.
 *
 * These tests pin the three things that make the fixed behaviour correct:
 *   1. the map centres on the device position, and Send becomes usable
 *   2. the position is REMEMBERED, so the next open starts there on frame one
 *   3. no pin is drawn while the position is still provisional or unknown —
 *      a marker that can't be sent must not look like one that can
 *
 * SAFE / self-cleaning: seeds one contact + conversation + message, removes them.
 */
import { test, expect } from "@playwright/test";
import { db, appAdmin } from "../_helpers/db";

const PREFIX = "e2e_loccomposer_";
// Somewhere unmistakably distant from the old hardcoded default (25, 45).
const GEO = { latitude: 48.858370, longitude: 2.294481 }; // Eiffel Tower

let workspaceId: string;
let contactId: string;

test.beforeAll(async () => {
  workspaceId = (await appAdmin()).workspaceId;
  const contact = await db().contact.create({
    data: {
      workspaceId,
      identityChannel: "whatsapp",
      phoneNumber: `9998${Date.now().toString().slice(-8)}`,
      name: `${PREFIX}Contact`,
      // The reply box disables every rich-send button (location included) when
      // the 24h messaging window is shut, so the fixture has to look like a
      // customer who just wrote in.
      lastInboundAt: new Date(),
    },
    select: { id: true },
  });
  contactId = contact.id;
  const convo = await db().conversation.create({
    data: {
      workspaceId,
      contactId,
      channel: "whatsapp",
      status: "open",
      lastMessageAt: new Date(),
      lastMessagePreview: "where are you?",
    },
    select: { id: true },
  });
  await db().message.create({
    data: {
      workspaceId,
      conversationId: convo.id,
      channel: "whatsapp",
      direction: "in",
      externalId: `${PREFIX}${Date.now()}`,
      body: "where are you?",
      status: "delivered",
    },
  });
});

test.afterAll(async () => {
  await db().message.deleteMany({ where: { workspaceId, conversation: { contactId } } });
  await db().conversation.deleteMany({ where: { workspaceId, contactId } });
  await db().contact.deleteMany({ where: { workspaceId, id: contactId } });
});

/** Open the seeded thread and click the location button. */
async function openComposer(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/inbox");
  const row = page.locator("div.h-20.cursor-pointer").first();
  await row.waitFor({ timeout: 30_000 });
  await row.click();
  const trigger = page.getByRole("button", { name: /send location/i }).first();
  await trigger.waitFor({ timeout: 30_000 });
  await trigger.click();
  await page.getByRole("dialog", { name: /send a location/i }).waitFor({ timeout: 15_000 });
}

/** The pin readout ("Pin: 48.85837, 2.29448") once a position is committed. */
function pinText(page: import("@playwright/test").Page) {
  return page.getByText(/^Pin:/);
}

/**
 * The composer's submit button. Scoped to the dialog: the reply-box TOOLBAR
 * icon that opens the composer also carries aria-label="Send location", so an
 * unscoped role query matches two elements.
 */
function sendButton(page: import("@playwright/test").Page) {
  return page
    .getByRole("dialog", { name: /send a location/i })
    .getByRole("button", { name: /send location/i });
}

test.describe("location composer opens at the agent's location", () => {
  test.use({ permissions: ["geolocation"], geolocation: GEO });

  test("centres on the device position and enables Send", async ({ page, context }) => {
    await context.grantPermissions(["geolocation"]);
    await openComposer(page);

    // The coarse, cache-allowed first stage should land quickly. 10s is a
    // generous ceiling that still fails loudly if the old forced-GPS options
    // (which could take the full 8s timeout and then fall back) come back.
    await expect(pinText(page)).toBeVisible({ timeout: 10_000 });
    await expect(pinText(page)).toContainText("48.858");
    await expect(pinText(page)).toContainText("2.294");

    // A usable pin means a usable Send.
    await expect(sendButton(page)).toBeEnabled();
  });

  test("remembers the position for the next open", async ({ page, context }) => {
    await context.grantPermissions(["geolocation"]);
    await openComposer(page);
    await expect(pinText(page)).toBeVisible({ timeout: 10_000 });

    const stored = await page.evaluate(() =>
      window.localStorage.getItem("ccp:location-composer:last-fix"),
    );
    expect(stored, "the fix is persisted for the next open").toBeTruthy();
    const fix = JSON.parse(stored!) as { lat: number; lon: number; zoom: number };
    expect(fix.lat).toBeCloseTo(GEO.latitude, 2);
    expect(fix.lon).toBeCloseTo(GEO.longitude, 2);
    // Zoomed to street level, not a country view — the whole complaint.
    expect(fix.zoom).toBeGreaterThanOrEqual(15);
  });
});

test.describe("location composer without a usable position", () => {
  // No `permissions` grant → getCurrentPosition rejects with PERMISSION_DENIED,
  // which is also what a Permissions-Policy block looks like.
  test.use({ permissions: [] });

  test("shows no pin and keeps Send disabled when location is denied", async ({
    page,
    context,
  }) => {
    await context.clearPermissions();
    await page.addInitScript(() => {
      window.localStorage.removeItem("ccp:location-composer:last-fix");
    });
    await openComposer(page);

    // The old build drew a confident red marker over its default centre even
    // though nothing was picked. Nothing sendable → nothing that looks sendable.
    await expect(pinText(page)).toHaveCount(0);
    await expect(sendButton(page)).toBeDisabled();
    await expect(
      page.getByText(/click the map to drop a pin|finding your location/i),
    ).toBeVisible();
  });

  test("a manual pin still works and is not clobbered", async ({ page, context }) => {
    await context.clearPermissions();
    await openComposer(page);

    // Click off-centre so the resulting pin is provably the click, not a
    // coincidence with the map centre.
    const map = page.locator('[role="dialog"] .relative.overflow-hidden.rounded-md').first();
    const box = await map.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.click(box!.x + box!.width * 0.3, box!.y + box!.height * 0.35);

    await expect(pinText(page)).toBeVisible({ timeout: 5_000 });
    await expect(sendButton(page)).toBeEnabled();

    // A manual pin is NOT "my location" — it must not be remembered as one,
    // or the next open would centre on a customer's address.
    const stored = await page.evaluate(() =>
      window.localStorage.getItem("ccp:location-composer:last-fix"),
    );
    if (stored) {
      const shown = await pinText(page).textContent();
      const fix = JSON.parse(stored) as { lat: number };
      expect(
        shown?.includes(fix.lat.toFixed(5)),
        "a manual pin must not overwrite the remembered device fix",
      ).toBeFalsy();
    }
  });
});
