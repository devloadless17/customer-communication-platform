/**
 * Campaign ACTIONS through a real session: bucketed retry and the streaming CSV
 * export. Both endpoints exist and are what make the report actionable rather
 * than a scoreboard, but neither has a UI affordance yet — so this is the only
 * thing standing between them and a silent regression.
 *
 * SAFE / self-cleaning: seeds under the admin team with an `e2e_actions_`
 * prefix and removes only that. No wipeTestData.
 */
import { test, expect } from "@playwright/test";
import { db, appAdmin } from "../_helpers/db";

test.describe.configure({ mode: "serial" });

const PREFIX = "e2e_actions_";
let workspaceId: string;
let broadcastId: string;

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
      totalCount: 4,
      sentCount: 1,
      failedCount: 3,
      completedAt: new Date(),
    },
    select: { id: true },
  });
  broadcastId = b.id;

  // Two RETRYABLE (rate limited) + one PERMANENT (invalid number) + one read.
  const plan = [
    { state: "failed_at_send", status: "failed", code: "rate_limited" },
    { state: "failed_at_send", status: "failed", code: "rate_limited" },
    { state: "failed_at_send", status: "failed", code: "invalid_recipient" },
    { state: "read", status: "sent", code: null },
  ] as const;
  let i = 0;
  for (const p of plan) {
    const c = await db().contact.create({
      data: {
        workspaceId,
        name: `${PREFIX}${i}`,
        phoneNumber: `1555${String(Date.now()).slice(-6)}${i++}`,
        identityChannel: "whatsapp",
        source: "manual",
      },
      select: { id: true },
    });
    await db().broadcastRecipient.create({
      data: {
        broadcastId,
        contactId: c.id,
        status: p.status,
        deliveryState: p.state,
        sentAt: new Date(),
        ...(p.code ? { errorCode: p.code, errorMessage: `${p.code}: seeded` } : {}),
      },
    });
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

test("CSV export streams the recipient report and honours the outcome filter", async ({ page }) => {
  await page.goto(`/broadcasts/${broadcastId}`);

  const all = await page.request.get(`/api/broadcasts/${broadcastId}/export`);
  expect(all.status()).toBe(200);
  expect(all.headers()["content-type"]).toContain("text/csv");
  expect(all.headers()["content-disposition"]).toContain("attachment");
  const csv = await all.text();
  // BOM so Excel opens UTF-8 without the import wizard.
  expect(csv.charCodeAt(0)).toBe(0xfeff);
  expect(csv).toContain("delivery_state");
  // Pre-computed deltas ship alongside ISO timestamps — nobody should have to
  // write a datetime-diff formula in a spreadsheet.
  expect(csv).toContain("seconds_to_read");
  expect(csv.trim().split("\r\n")).toHaveLength(5); // header + 4 recipients

  // "Export what I'm looking at": the same filter vocabulary as the report.
  const filtered = await page.request.get(
    `/api/broadcasts/${broadcastId}/export?errorCode=invalid_recipient`,
  );
  expect(filtered.status()).toBe(200);
  const rows = (await filtered.text()).trim().split("\r\n");
  expect(rows).toHaveLength(2); // header + the single invalid number
  expect(rows[1]).toContain("invalid_recipient");
});

test("bucketed retry re-queues ONLY the chosen failure bucket", async ({ page }) => {
  await page.goto(`/broadcasts/${broadcastId}`);

  const res = await page.request.post(`/api/broadcasts/${broadcastId}/retry`, {
    data: { errorCodes: ["rate_limited"] },
  });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as { requeued: number };
  // The two rate-limited ones — NOT the permanently-invalid number, which would
  // just fail again and burn throughput against the number's quality rating.
  expect(body.requeued).toBe(2);

  const states = await db().broadcastRecipient.findMany({
    where: { broadcastId },
    select: { status: true, errorCode: true },
  });
  const invalid = states.find((s) => s.errorCode === "invalid_recipient");
  expect(invalid?.status).toBe("failed"); // untouched
  expect(states.filter((s) => s.status === "queued")).toHaveLength(2);
});
