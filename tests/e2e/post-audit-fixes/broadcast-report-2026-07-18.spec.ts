/**
 * Campaign report (Phase 1): the delivery funnel, its rates, the failure
 * breakdown bucketed by what to DO about it, and the diagnostics that turn a
 * number into a next action.
 *
 * Seeds one campaign whose recipients span every delivery state, then asserts
 * (a) the report API's funnel maths and (b) that the page renders it. The maths
 * is worth pinning: `read` implies delivered, so "reached the phone" is
 * delivered + read — getting that wrong makes a read-heavy campaign report a
 * nonsense delivery rate.
 *
 * SAFE / self-cleaning: seeds under the admin team with an `e2e_report_` prefix
 * and deletes only that. Does NOT call wipeTestData, so the maintainer's data is
 * untouched.
 */
import { test, expect } from "@playwright/test";
import { db, appAdmin } from "../_helpers/db";

test.describe.configure({ mode: "serial" });

const PREFIX = "e2e_report_";
let workspaceId: string;
let broadcastId: string;

// A deliberately lopsided campaign: a big undelivered bucket (so the
// invalid-numbers diagnostic fires) and a low read rate.
const PLAN = [
  { state: "read", n: 3 },
  { state: "delivered", n: 5 },
  { state: "undelivered", n: 4, errorCode: "invalid_recipient" },
  { state: "failed_at_send", n: 2, errorCode: "rate_limited" },
  { state: "sent", n: 1 },
] as const;

test.beforeAll(async () => {
  workspaceId = (await appAdmin()).workspaceId;
  const b = await db().broadcast.create({
    data: {
      workspaceId,
      status: "completed",
      kind: "template",
      targetMode: "contact",
      channel: "whatsapp",
      templateName: `${PREFIX}campaign`,
      templateLanguage: "en",
      variables: { body: [] },
      audienceMode: "all",
      totalCount: 15,
      sentCount: 13,
      failedCount: 2,
      startedAt: new Date(Date.now() - 60_000),
      completedAt: new Date(),
    },
    select: { id: true },
  });
  broadcastId = b.id;

  let i = 0;
  for (const group of PLAN) {
    for (let k = 0; k < group.n; k++) {
      const contact = await db().contact.create({
        data: {
          workspaceId,
          name: `${PREFIX}${group.state}_${k}`,
          phoneNumber: `+1555${String(7000000 + i++).slice(0, 7)}`,
          identityChannel: "whatsapp",
          source: "manual",
        },
        select: { id: true },
      });
      await db().broadcastRecipient.create({
        data: {
          broadcastId,
          contactId: contact.id,
          status: group.state === "failed_at_send" ? "failed" : "sent",
          deliveryState: group.state,
          sentAt: new Date(),
          ...("errorCode" in group && group.errorCode
            ? { errorCode: group.errorCode, errorMessage: `${group.errorCode}: seeded` }
            : {}),
          ...(group.state === "delivered" || group.state === "read"
            ? { deliveredAt: new Date() }
            : {}),
          ...(group.state === "read" ? { readAt: new Date() } : {}),
        },
      });
    }
  }
});

test.afterAll(async () => {
  const rows = await db().broadcast.findMany({
    where: { templateName: { startsWith: PREFIX } },
    select: { id: true },
  });
  const ids = rows.map((r) => r.id);
  if (ids.length) {
    await db().broadcastRecipient.deleteMany({ where: { broadcastId: { in: ids } } });
    await db().broadcast.deleteMany({ where: { id: { in: ids } } });
  }
  await db().contact.deleteMany({ where: { workspaceId, name: { startsWith: PREFIX } } });
  await db().$disconnect();
});

test("report API computes the funnel, rates and actionable failure buckets", async ({ page }) => {
  // Session-authed route — go through the browser context so the auth cookie rides along.
  await page.goto(`/broadcasts/${broadcastId}`);
  const res = await page.request.get(`/api/broadcasts/${broadcastId}/report`);
  // NOTE: a 500 here almost certainly means the api process predates this
  // feature's Prisma client / module graph — restart the dev api. The route was
  // verified returning 200 with the exact payload below against a freshly-booted
  // api on the same database.
  if (!res.ok()) throw new Error(`report ${res.status()}: ${await res.text()}`);
  const { report } = (await res.json()) as { report: Record<string, never> & any };

  const f = report.funnel;
  expect(f.targeted).toBe(15);
  expect(f.read).toBe(3);
  expect(f.delivered).toBe(5);
  expect(f.undelivered).toBe(4);
  expect(f.failedAtSend).toBe(2);

  // `read` implies delivered — reached is delivered + read, not delivered alone.
  expect(f.reached).toBe(8);
  // Accepted by Meta = everything that got a wamid: reached + undelivered + sent.
  expect(f.accepted).toBe(13);
  // The question clients actually ask.
  expect(f.neverReceived).toBe(6); // 2 failed at send + 4 undelivered

  // deliveryRate = reached / accepted = 8/13; readRate = read / reached = 3/8.
  expect(report.rates.deliveryRate).toBeCloseTo(8 / 13, 2);
  expect(report.rates.readRate).toBeCloseTo(3 / 8, 2);

  // Failures carry the actionability bucket, not just a count.
  const byCode = Object.fromEntries(
    report.failures.map((x: { errorCode: string }) => [x.errorCode, x]),
  );
  expect(byCode["invalid_recipient"].count).toBe(4);
  expect(byCode["invalid_recipient"].bucket).toBe("permanent"); // clean the list
  expect(byCode["rate_limited"].count).toBe(2);
  expect(byCode["rate_limited"].bucket).toBe("retryable"); // safe to re-send

  // Diagnostics must be actionable, not decorative: >10% invalid numbers and a
  // retryable bucket both present, so both cards should fire.
  const codes = report.diagnostics.map((d: { code: string }) => d.code);
  expect(codes).toContain("high_invalid_numbers");
  expect(codes).toContain("retryable_failures");
});

test("detail page renders the funnel, the never-received callout and a diagnostic action", async ({
  page,
}) => {
  await page.goto(`/broadcasts/${broadcastId}`);

  await expect(page.getByText("Delivery funnel")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Reached the phone")).toBeVisible();
  // The headline answer to "who didn't get it".
  await expect(page.getByText(/6 never received the message/)).toBeVisible();
  // Actionable failure bucketing is on screen, not buried in an API response.
  await expect(page.getByText("Invalid or unreachable number")).toBeVisible();
  await expect(page.getByText("Clean list").first()).toBeVisible();
  // A diagnostic with a real next action.
  await expect(page.getByText(/4 numbers were invalid/)).toBeVisible();
});
