/**
 * Regression gate for the 2026-07-21 team-chat UI pass.
 *
 * Every assertion here corresponds to a defect that actually shipped, and each
 * one is checked by MEASURING the rendered DOM rather than by looking for a
 * class name — the whole point is that the class names looked right while the
 * layout was wrong (an invisible hover timestamp inflating grouped rows; a
 * `wrap-break-words` utility that doesn't exist; `px-2` silently dropped by an
 * absolutely-positioned virtual row; a popover clipped by its scroller).
 *
 * SAFE / self-cleaning: seeds one peer user + its DM under the admin team and
 * removes both afterwards.
 */
import { test, expect, type Page } from "@playwright/test";
import { createTestUser, db, appAdmin } from "../_helpers/db";

test.describe.configure({ mode: "serial" });

const PREFIX = "e2e_tcpolish_";
const CHAN_PREFIX = "e2e-tcpolish-";
let workspaceId: string;
let adminUserId: string;
let peerUserId: string;

test.beforeAll(async () => {
  const admin = await appAdmin();
  workspaceId = admin.workspaceId;
  adminUserId = admin.userId;
  const peer = await createTestUser({ workspaceId: workspaceId, role: "agent", email: `${PREFIX}peer@example.test`, name: `${PREFIX}Peer Person` });
  peerUserId = peer.id;
});

test.afterAll(async () => {
  await db().teamChannel.deleteMany({ where: { workspaceId, kind: "dm" } });
  await db().teamChannel.deleteMany({
    where: { workspaceId, name: { startsWith: CHAN_PREFIX } },
  });
  await db().user.deleteMany({ where: { workspaceMemberships: { some: { workspaceId } }, email: { startsWith: PREFIX } } });
});

/** Open /team and wait for the feed (not networkidle — the socket never idles). */
async function openTeam(page: Page): Promise<void> {
  await page.goto("/team");
  await expect(page.getByText("Channels", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
}

function composer(page: Page) {
  return page.getByPlaceholder(/^Message #|^Send a message/).first();
}

async function send(page: Page, body: string): Promise<void> {
  const box = composer(page);
  await box.waitFor({ timeout: 30_000 });
  await box.fill(body);
  await box.press("Enter");
  // The composer ignores Enter while a previous send is still in flight, so
  // wait for it to clear before the caller queues another one.
  await expect(box).toHaveValue("", { timeout: 15_000 });
  await expect(
    page.locator("[data-message-id]").filter({ hasText: body }).last(),
  ).toBeVisible({ timeout: 15_000 });
}

/** Height of the row whose body matches `text`. */
async function rowHeight(page: Page, text: string): Promise<number> {
  const box = await page
    .locator("[data-message-id]")
    .filter({ hasText: text })
    .last()
    .boundingBox();
  return box?.height ?? -1;
}

test("a grouped (continuation) row is tight — no phantom gap from the hover timestamp", async ({
  page,
}) => {
  await openTeam(page);
  const tag = `grp-${Date.now()}`;
  await send(page, `${tag}-head`);
  await send(page, `${tag}-cont`);

  const cont = await rowHeight(page, `${tag}-cont`);
  // The regression: a one-line grouped row measured ~54px because an
  // opacity-0 hover timestamp wrapped to two 24px line boxes in the gutter.
  // One line of `text-sm/leading-relaxed` inside `py-0.5` is ~27px.
  expect(cont).toBeGreaterThan(0);
  expect(cont).toBeLessThan(36);

  // And the row genuinely OWNS that height — the virtualizer positions the
  // next row directly beneath it, so a stale estimate would show up as a gap.
  const gap = await page.evaluate((t: string) => {
    const rows = Array.from(document.querySelectorAll("[data-message-id]"));
    const i = rows.findIndex((r) => (r.textContent ?? "").includes(`${t}-cont`));
    if (i < 1) return -1;
    const prev = rows[i - 1]!.getBoundingClientRect();
    const cur = rows[i]!.getBoundingClientRect();
    return cur.top - prev.bottom;
  }, tag);
  expect(Math.abs(gap)).toBeLessThan(2);
});

test("a long unbroken string wraps instead of running out of the column", async ({
  page,
}) => {
  await openTeam(page);
  const body = "z".repeat(200);
  await send(page, body);

  const measured = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("[data-message-id]"));
    const row = rows[rows.length - 1] as HTMLElement;
    const span = row.querySelector("span.whitespace-pre-wrap") as HTMLElement | null;
    return {
      rowWidth: row.getBoundingClientRect().width,
      spanWidth: span?.getBoundingClientRect().width ?? -1,
      overflowWrap: span ? getComputedStyle(span).overflowWrap : "none",
      docOverflow:
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });

  // `wrap-break-words` (plural) is not a Tailwind utility and emitted no CSS.
  expect(measured.overflowWrap).toBe("break-word");
  expect(measured.spanWidth).toBeLessThanOrEqual(measured.rowWidth);
  expect(measured.docOverflow).toBe(0);
});

test("the composer emoji panel opens inside the viewport", async ({ page }) => {
  await openTeam(page);
  await composer(page).waitFor({ timeout: 30_000 });
  await page.getByLabel("Insert emoji").click();

  const rect = await page.evaluate(() => {
    const el = document.querySelector(".w-72.overflow-hidden.rounded-xl");
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { left: b.left, right: b.right, vw: window.innerWidth };
  });
  expect(rect).not.toBeNull();
  // The trigger sits at the right edge, so a left-anchored panel ran off-page.
  expect(rect!.right).toBeLessThanOrEqual(rect!.vw);
  expect(rect!.left).toBeGreaterThanOrEqual(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBe(0);
});

test("the reaction emoji panel flips down instead of being clipped by the thread scroller", async ({
  page,
}) => {
  await openTeam(page);
  const tag = `thr-${Date.now()}`;
  await send(page, tag);

  const row = page.locator("[data-message-id]").filter({ hasText: tag }).last();
  await row.hover();
  await row.getByLabel("Reply in thread").click();

  const aside = page.locator("aside").filter({ hasText: "Thread" }).first();
  const root = aside.locator("[data-message-id]").first();
  await root.hover();
  await root.getByLabel("Add reaction").click();
  await aside.getByLabel("More reactions").click();

  const geom = await page.evaluate(() => {
    const el = document.querySelector(".w-72.overflow-hidden.rounded-xl");
    if (!el) return null;
    const b = el.getBoundingClientRect();
    let clipTop = 0;
    for (let n = el.parentElement; n; n = n.parentElement) {
      const o = getComputedStyle(n).overflowY;
      if (o === "auto" || o === "scroll" || o === "hidden") {
        clipTop = n.getBoundingClientRect().top;
        break;
      }
    }
    return { top: b.top, clipTop };
  });
  expect(geom).not.toBeNull();
  // It used to render above the trigger and get cut off by the scroller.
  expect(geom!.top).toBeGreaterThanOrEqual(geom!.clipTop - 1);
});

test("editing shows (edited) even on a grouped row, where the author header is hidden", async ({
  page,
}) => {
  await openTeam(page);
  const tag = `edit-${Date.now()}`;
  await send(page, `${tag}-head`);
  await send(page, `${tag}-cont`);

  const row = page.locator("[data-message-id]").filter({ hasText: `${tag}-cont` }).last();
  await row.hover();
  await row.getByLabel("More actions").click();
  await page.getByText("Edit message").click();
  const ta = row.locator("textarea").first();
  await ta.fill(`${tag}-cont-changed`);
  await ta.press("ControlOrMeta+Enter");

  await expect(
    page
      .locator("[data-message-id]")
      .filter({ hasText: `${tag}-cont-changed` })
      .last()
      .getByText("(edited)"),
  ).toBeVisible({ timeout: 15_000 });
});

test("channel rows and DM rows share the same inset — the active row never touches the rail", async ({
  page,
  request,
}) => {
  await request.post("/api/team/channels/dm", { data: { userId: peerUserId } });
  await request.post("/api/team/channels", {
    data: { name: `${CHAN_PREFIX}inset`, visibility: "public" },
  });

  await openTeam(page);
  await expect(page.getByText(`${PREFIX}Peer Person`)).toBeVisible({ timeout: 30_000 });

  const lefts = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href^="/team/"]')).map((a) =>
      Math.round(a.getBoundingClientRect().left),
    ),
  );
  expect(lefts.length).toBeGreaterThan(1);
  // Channel rows are virtualized (absolutely positioned) and DM rows are not;
  // the container's `px-2` used to apply to only one of them.
  expect(new Set(lefts).size).toBe(1);
});

test("a search-result highlight is dismissible and does not survive a reload", async ({
  page,
  request,
}) => {
  const tag = `needle${Date.now()}`;
  await openTeam(page);
  await send(page, `${tag} in a haystack`);

  const list = await (
    await request.get("/api/team/channels?take=50")
  ).json();
  const channelId: string = (list.items ?? list.channels ?? list)[0].id;

  const msgs = await (
    await request.get(`/api/team/channels/${channelId}/messages?take=50`)
  ).json();
  const hit = (msgs.items ?? []).find((m: { body: string }) => m.body?.includes(tag));
  expect(hit, "seeded message should be findable").toBeTruthy();

  await page.goto(`/team/${channelId}?jumpTo=${hit.id}&q=${tag}`);
  await expect(page.getByText(/Highlighting matches for/)).toBeVisible({
    timeout: 30_000,
  });
  // The params are stripped immediately, so a reload lands clean.
  await expect.poll(() => new URL(page.url()).search).toBe("");

  await page.getByRole("button", { name: "Clear" }).click();
  await expect(page.getByText(/Highlighting matches for/)).toHaveCount(0);

  await page.reload();
  await expect(page.getByText(/Highlighting matches for/)).toHaveCount(0);
  expect(await page.locator("mark").count()).toBe(0);
});

test("a staged attachment does not follow you into another channel", async ({
  page,
  request,
}) => {
  const other = await (
    await request.post("/api/team/channels", {
      data: { name: `${CHAN_PREFIX}staged`, visibility: "public" },
    })
  ).json();

  await openTeam(page);
  await composer(page).waitFor({ timeout: 30_000 });

  // Stage a file without sending it.
  await page.setInputFiles('input[type="file"]', {
    name: "confidential.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("secret"),
  });
  await expect(page.getByText("confidential.txt")).toBeVisible();

  // Switch channels. The composer is NOT remounted, so the staged file used
  // to still be sitting there — and the next Send uploaded it here.
  await page.goto(`/team/${(other.channel ?? other).id}`);
  await composer(page).waitFor({ timeout: 30_000 });
  await expect(page.getByText("confidential.txt")).toHaveCount(0);
});

test("per-channel chrome resets on a channel switch", async ({ page, request }) => {
  const other = await (
    await request.post("/api/team/channels", {
      data: { name: `${CHAN_PREFIX}reset`, visibility: "public" },
    })
  ).json();

  await openTeam(page);
  await composer(page).waitFor({ timeout: 30_000 });

  // Open the in-channel search and type a query.
  await page.getByRole("button", { name: /search/i }).first().click();
  const search = page.getByPlaceholder(/search/i).last();
  await search.fill("carryover");
  await expect(search).toHaveValue("carryover");

  await page.goto(`/team/${(other.channel ?? other).id}`);
  await composer(page).waitFor({ timeout: 30_000 });
  // The search bar used to still be open, still pre-filled, silently
  // re-running the previous channel's query against this one.
  await expect(page.locator('input[value="carryover"]')).toHaveCount(0);
  await expect(page.getByPlaceholder(/search/i)).toHaveCount(0);
});

test("the reaction endpoint refuses a non-emoji", async ({ page, request }) => {
  await openTeam(page);
  const tag = `react-${Date.now()}`;
  await send(page, tag);

  const channelId = new URL(page.url()).pathname.split("/").pop()!;
  const msgs = await (
    await request.get(`/api/team/channels/${channelId}/messages?take=50`)
  ).json();
  const hit = (msgs.items ?? []).find((m: { body: string }) => m.body === tag);
  expect(hit).toBeTruthy();

  // A byte cap alone let arbitrary text become a permanent reaction chip.
  const bad = await request.post(
    `/api/team/channels/${channelId}/messages/${hit.id}/reactions`,
    { data: { emoji: "PAY ME BITCOIN" } },
  );
  expect(bad.status()).toBe(400);

  const good = await request.post(
    `/api/team/channels/${channelId}/messages/${hit.id}/reactions`,
    { data: { emoji: "👍" } },
  );
  expect(good.ok()).toBeTruthy();
});

test("a garbage ?take returns a 400, not a 500", async ({ page, request }) => {
  await openTeam(page);
  const channelId = new URL(page.url()).pathname.split("/").pop()!;

  // `take ? parseInt(take) : undefined` produced NaN → Prisma `take: NaN` →
  // PrismaClientValidationError, which the exception filter does not map.
  for (const path of [
    `/api/team/channels/${channelId}/messages?take=abc`,
    `/api/team/channels/${channelId}/messages/search?q=hello&take=abc`,
    `/api/team/channels/search?q=hello&take=abc`,
  ]) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(400);
  }

  // And a negative take can't silently truncate the page to zero rows.
  const neg = await request.get(
    `/api/team/channels/${channelId}/messages?take=-1`,
  );
  expect(neg.status()).toBe(400);
});

test("a DM with a departed teammate is read-only, in the UI AND on the server", async ({
  page,
  request,
}) => {
  const dm = (
    await (await request.post("/api/team/channels/dm", { data: { userId: peerUserId } })).json()
  ).channel;

  // The peer leaves the team.
  await db().user.update({
    where: { id: peerUserId },
    data: { deactivatedAt: new Date() },
  });

  try {
    await page.goto(`/team/${dm.id}`);
    // Composer swapped for an explanation — the contract
    // `DirectMessagePeerDto.deactivated` documented but nothing enforced.
    await expect(page.getByText(/no longer has an account/i)).toBeVisible({
      timeout: 30_000,
    });
    await expect(composer(page)).toHaveCount(0);

    // And the rule is the server's, not just an affordance a direct POST
    // could walk around.
    const res = await request.post(`/api/team/channels/${dm.id}/messages`, {
      data: { body: "handover note nobody will read" },
    });
    expect(res.status()).toBe(422);
    expect((await res.json()).error).toBe("dm_peer_deactivated");
  } finally {
    await db().user.update({
      where: { id: peerUserId },
      data: { deactivatedAt: null },
    });
  }
});

test("a self-DM stays writable — it has no peer to deactivate", async ({ request }) => {
  const dm = (
    await (
      await request.post("/api/team/channels/dm", { data: { userId: adminUserId } })
    ).json()
  ).channel;
  const res = await request.post(`/api/team/channels/${dm.id}/messages`, {
    data: { body: `note-to-self-${Date.now()}` },
  });
  expect(res.ok()).toBeTruthy();
});

test("a brand-new DM renders the peer on first paint, before the layout refetches", async ({
  page,
  request,
}) => {
  const dm = (
    await (await request.post("/api/team/channels/dm", { data: { userId: peerUserId } })).json()
  ).channel;

  // Land directly on the DM with a COLD client: the layout's DM list is the
  // only other source of the peer, and this exercises the server-rendered one.
  await page.goto(`/team/${dm.id}`);
  // The peer's NAME is the header title. ("Direct message" still appears as
  // the subtitle line under it — that's the channel-type label, not a
  // fallback.) Before the server resolved the peer, the title itself read
  // "Direct message" over a blank avatar until the layout refetched.
  const header = page.locator("header, div").filter({ hasText: `${PREFIX}Peer Person` }).first();
  await expect(header).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(`${PREFIX}Peer Person`).first()).toBeVisible();
});

test("opening a DM does not notify or ding the person who opened it", async ({
  page,
}) => {
  await openTeam(page);

  await page.getByRole("button", { name: "New direct message" }).click();
  await page.getByText(`${PREFIX}Peer Person`).last().click();

  // Land in the DM…
  await expect(composer(page)).toBeVisible({ timeout: 30_000 });
  // …with no self-addressed alert. The frame fans to BOTH participants, and
  // the starter's tab used to lose the race against its own POST response.
  await expect(page.getByText("New direct message", { exact: true })).toHaveCount(0);
});
