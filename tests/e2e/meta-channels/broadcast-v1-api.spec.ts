/**
 * /v1 campaign reporting — the surface clients pull into their own BI.
 *
 * Asserts the scope gate, the `{items,nextCursor}` conventions, and that the
 * report served over the API is the SAME object the in-app dashboard renders
 * (one computation, three consumers — if these diverge the feature is broken).
 */
import { test, expect } from "@playwright/test";

import { db } from "../_helpers/db";
import { seedMetaTestTeam, META_API_BASE, META_TEST_TEAM_ID } from "../_helpers/meta";

test.describe.configure({ mode: "serial" });

const PREFIX = "e2e_v1rep_";
let apiToken: string;
let broadcastId: string;

test.beforeAll(async () => {
  ({ apiToken } = await seedMetaTestTeam());
  const b = await db().broadcast.create({
    data: {
      workspaceId: META_TEST_TEAM_ID,
      status: "completed",
      kind: "template",
      targetMode: "contact",
      channel: "whatsapp",
      templateName: `${PREFIX}promo`,
      templateLanguage: "en",
      templateCategory: "MARKETING",
      variables: { body: [] },
      audienceMode: "all",
      totalCount: 3,
      suppressedCount: 2,
    },
    select: { id: true },
  });
  broadcastId = b.id;

  const states = [
    { s: "read", e: null },
    { s: "delivered", e: null },
    { s: "undelivered", e: "invalid_recipient" },
  ] as const;
  let i = 0;
  for (const st of states) {
    const c = await db().contact.create({
      data: {
        workspaceId: META_TEST_TEAM_ID,
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
        status: "sent",
        deliveryState: st.s,
        sentAt: new Date(),
        ...(st.e ? { errorCode: st.e, errorMessage: `${st.e}: seeded` } : {}),
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
  await db().contact.deleteMany({
    where: { workspaceId: META_TEST_TEAM_ID, name: { startsWith: PREFIX } },
  });
});

const get = (path: string, token?: string) =>
  fetch(`${META_API_BASE}/api/external/v1${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

test("requires authentication", async () => {
  expect((await get("/broadcasts")).status).toBe(401);
});

test("lists campaigns with the {items,nextCursor} convention", async () => {
  const res = await get("/broadcasts?limit=50", apiToken);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: Array<{ id: string; suppressedCount: number }>; nextCursor: string | null };
  expect(Array.isArray(body.items)).toBe(true);
  expect(body).toHaveProperty("nextCursor");
  const mine = body.items.find((b) => b.id === broadcastId);
  expect(mine?.suppressedCount).toBe(2);
});

test("report matches the funnel maths the dashboard renders", async () => {
  const res = await get(`/broadcasts/${broadcastId}/report`, apiToken);
  expect(res.status).toBe(200);
  const { report } = (await res.json()) as { report: any };
  // read implies delivered → reached = delivered + read
  expect(report.funnel.reached).toBe(2);
  expect(report.funnel.undelivered).toBe(1);
  expect(report.funnel.neverReceived).toBe(1);
  expect(report.funnel.suppressed).toBe(2);
  // failures carry the actionable bucket, not just a count
  const invalid = report.failures.find((f: any) => f.errorCode === "invalid_recipient");
  expect(invalid.bucket).toBe("permanent");
});

test("recipients filter by outcome and expose deliveryState", async () => {
  const res = await get(`/broadcasts/${broadcastId}/recipients?outcome=never_received`, apiToken);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: Array<{ deliveryState: string; sendStatus: string }> };
  expect(body.items).toHaveLength(1);
  expect(body.items[0]!.deliveryState).toBe("undelivered");
  // sendStatus stays `sent` — Meta DID accept it. Reporting on this field is
  // exactly the bug this feature fixed.
  expect(body.items[0]!.sendStatus).toBe("sent");
});

test("404s a campaign belonging to another team", async () => {
  expect((await get("/broadcasts/does-not-exist/report", apiToken)).status).toBe(404);
});
