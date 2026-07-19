/**
 * Visual smoke test for the team-chat surface changes: the sectioned sidebar
 * (Channels + Direct messages), the Browse-channels entry point, and the DM
 * thread rendering with the peer's identity in the header.
 *
 * Deliberately assertion-light and screenshot-heavy — its job is to prove the
 * new surfaces actually MOUNT and paint, which no API test can do.
 *
 * SAFE / self-cleaning: seeds one DM under the admin team, removes it after.
 */
import { test, expect } from "@playwright/test";
import { db, appAdmin } from "../_helpers/db";

test.describe.configure({ mode: "serial" });

const PREFIX = "e2e_tcui_";
/**
 * Channel-name prefix. MUST be the dash form: normalizeChannelName rewrites
 * every non [a-z0-9-] char to a dash, so an underscore-prefixed name is
 * stored (and rendered, and cleaned up) as dashes.
 */
const CHAN_PREFIX = "e2e-tcui-";
let teamId: string;
let peerUserId: string;

test.beforeAll(async () => {
  teamId = (await appAdmin()).teamId;
  const peer = await db().user.create({
    data: {
      teamId,
      email: `${PREFIX}peer@example.test`,
      name: `${PREFIX}Peer Person`,
      role: "agent",
    },
    select: { id: true },
  });
  peerUserId = peer.id;
});

test.afterAll(async () => {
  await db().teamChannel.deleteMany({ where: { teamId, kind: "dm" } });
  await db().teamChannel.deleteMany({
    where: { teamId, name: { startsWith: CHAN_PREFIX } },
  });
  await db().user.deleteMany({ where: { teamId, email: { startsWith: PREFIX } } });
});

test("the sidebar renders a Direct messages section and a Browse entry point", async ({
  page,
  request,
}) => {
  // Seed a DM so the section has a row to render.
  const res = await request.post("/api/team/channels/dm", {
    data: { userId: peerUserId },
  });
  expect(res.ok()).toBeTruthy();

  await page.goto("/team");
  // NOT waitForLoadState("networkidle") — team chat holds a persistent
  // Socket.io connection, so the network never goes idle and that wait just
  // burns its timeout. Wait for the surface to paint instead.
  await expect(page.getByText("Channels", { exact: true })).toBeVisible({
    timeout: 30_000,
  });

  // The new section header.
  await expect(page.getByText("Direct messages", { exact: true })).toBeVisible();
  // The channel section still there — the sidebar is sectioned, not replaced.
  await expect(page.getByText("Channels", { exact: true })).toBeVisible();
  // Browse entry point (the discovery affordance that made channels feel
  // less locked-down).
  await expect(page.getByRole("button", { name: "Browse public channels" })).toBeVisible();
  // The DM row itself, rendered from the peer's identity rather than a name.
  await expect(page.getByText(`${PREFIX}Peer Person`)).toBeVisible();

  await page.screenshot({ path: "test-results/teamchat-sidebar.png", fullPage: false });
});

test("the Browse channels dialog opens and lists public channels", async ({
  page,
  request,
}) => {
  await request.post("/api/team/channels", {
    data: { name: `${CHAN_PREFIX}browsable`, visibility: "public" },
  });

  await page.goto("/team");
  const browseBtn = page.getByRole("button", { name: "Browse public channels" });
  await expect(browseBtn).toBeVisible({ timeout: 30_000 });
  await browseBtn.click();

  await expect(page.getByText("Browse channels")).toBeVisible();
  // The copy that explains WHY a private channel isn't listed.
  await expect(page.getByText(/Private channels are/i)).toBeVisible();
  await expect(page.getByText(`${CHAN_PREFIX}browsable`)).toBeVisible();

  await page.screenshot({ path: "test-results/teamchat-browse.png" });
});

test("opening a DM shows the peer in the header, with no channel-admin controls", async ({
  page,
  request,
}) => {
  const dm = (
    await (await request.post("/api/team/channels/dm", { data: { userId: peerUserId } })).json()
  ).channel;

  await page.goto(`/team/${dm.id}`);

  // Peer identity stands in for the channel name.
  await expect(page.getByText(`${PREFIX}Peer Person`).first()).toBeVisible({
    timeout: 30_000,
  });
  // A DM has nothing to administer — the members button is channel-only.
  await expect(page.getByRole("button", { name: "Channel members" })).toHaveCount(0);

  await page.screenshot({ path: "test-results/teamchat-dm.png" });
});
