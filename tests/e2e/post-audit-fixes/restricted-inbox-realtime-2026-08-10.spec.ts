import { expect, test, type Page } from "@playwright/test";

import { db } from "../_helpers/db";
import { assignConversation } from "../_helpers/api";
import {
  RESTRICTED_AGENT_EMAIL,
  RESTRICTED_AGENT_PASSWORD,
  loginAs,
  seedConversation,
  seedRestrictedAgent,
  setAgentVisibility,
} from "../_helpers/restricted";

/**
 * The restricted-agent INBOX boundary, end to end — the conversation-side
 * counterpart of ticket-realtime-2026-08-02. A restricted agent (role=agent
 * under `agentConversationVisibility: "assigned"`) logs in in context B; the
 * admin acts over HTTP; every assertion is about B's screen changing WITHOUT
 * a reload:
 *
 *   1. Assignment in/out is live, and losing the OPEN thread revokes the pane.
 *   2. The list shows only their conversations.
 *   3. THE FLIP: an admin turning the restriction on prunes an already-open
 *      unrestricted agent's inbox live (cache bust → catalog tick → forced
 *      reconnect), and turning it off restores it — the revocation hole fix.
 *   4. Workspace metadata still reaches them (the wsmeta room): a stage
 *      created by the admin appears in their inbox sidebar with no reload.
 *
 *   E2E_BASE_URL=http://localhost:3000 pnpm exec playwright test tests/e2e/post-audit-fixes/restricted-inbox-realtime-2026-08-10.spec.ts
 */

test.describe.configure({ mode: "serial" });

test("assignment in/out is live, and losing the open thread revokes the pane", async ({
  browser,
  page: adminPage,
}) => {
  test.setTimeout(300_000);
  const { userId: agentId } = await seedRestrictedAgent();
  await setAgentVisibility("assigned");
  const { conversationId, contactName } = await seedConversation("RIA In-Out");

  let agentPage: Page | null = null;
  try {
    agentPage = await loginAs(browser, RESTRICTED_AGENT_EMAIL, RESTRICTED_AGENT_PASSWORD);
    await agentPage.goto("/inbox", { timeout: 120_000, waitUntil: "domcontentloaded" });
    await agentPage.waitForTimeout(2_500); // socket connected + first seed
    await expect(agentPage.getByText(contactName)).toHaveCount(0);

    // Admin assigns the thread TO the restricted agent → the row appears live
    // (user-room co-target on conversation:assigned + recoverConversation).
    await assignConversation(adminPage.request, conversationId, agentId);
    await expect(agentPage.getByText(contactName).first()).toBeVisible({ timeout: 20_000 });

    // Open it, so the revocation below hits the ACTIVE pane. The `?c=` param
    // is the structural truth of "this thread is open".
    await agentPage.getByText(contactName).first().click();
    await agentPage.waitForURL((u) => u.searchParams.get("c") === conversationId, {
      timeout: 30_000,
    });

    // Admin takes it away → list row drops AND the open pane clears with a
    // toast, because every further read/write on it would 404 anyway.
    await assignConversation(adminPage.request, conversationId, null);
    await expect(
      agentPage.locator("[data-sonner-toast]", { hasText: /reassigned/i }).first(),
    ).toBeVisible({ timeout: 20_000 });
    // Pane cleared: the `?c=` is stripped by the revocation side-effect.
    await agentPage.waitForURL((u) => u.searchParams.get("c") === null, { timeout: 20_000 });
    await expect(agentPage.getByText(contactName)).toHaveCount(0, { timeout: 20_000 });
  } finally {
    await setAgentVisibility("team");
    await agentPage?.context().close();
    await db().conversation.deleteMany({ where: { id: conversationId } });
  }
});

test("the list is scoped: a teammate's conversation never renders", async ({
  browser,
  page: adminPage,
}) => {
  test.setTimeout(240_000);
  const { userId: agentId } = await seedRestrictedAgent();
  await setAgentVisibility("assigned");
  const mine = await seedConversation("RIA Mine");
  const foreign = await seedConversation("RIA Foreign");

  let agentPage: Page | null = null;
  try {
    // One thread is theirs, one belongs to nobody (≠ them either way).
    await assignConversation(adminPage.request, mine.conversationId, agentId);

    agentPage = await loginAs(browser, RESTRICTED_AGENT_EMAIL, RESTRICTED_AGENT_PASSWORD);
    await agentPage.goto("/inbox", { timeout: 120_000, waitUntil: "domcontentloaded" });
    await expect(agentPage.getByText(mine.contactName).first()).toBeVisible({
      timeout: 60_000,
    });
    await expect(agentPage.getByText(foreign.contactName)).toHaveCount(0);
  } finally {
    await setAgentVisibility("team");
    await agentPage?.context().close();
    await db().conversation.deleteMany({
      where: { id: { in: [mine.conversationId, foreign.conversationId] } },
    });
  }
});

test("THE FLIP: turning the restriction on prunes a live agent's inbox without a reload — and off restores it", async ({
  browser,
  page: adminPage,
}) => {
  test.setTimeout(300_000);
  await seedRestrictedAgent();
  // Start UNRESTRICTED: the agent sees the whole floor.
  await setAgentVisibility("team");
  const foreign = await seedConversation("RIA Flip");

  let agentPage: Page | null = null;
  try {
    agentPage = await loginAs(browser, RESTRICTED_AGENT_EMAIL, RESTRICTED_AGENT_PASSWORD);
    await agentPage.goto("/inbox", { timeout: 120_000, waitUntil: "domcontentloaded" });
    // Under "team" visibility the foreign thread is visible.
    await expect(agentPage.getByText(foreign.contactName).first()).toBeVisible({
      timeout: 60_000,
    });

    // Admin flips the workspace to assigned-only THROUGH THE API (the write
    // path is what busts the caches + disconnects the sockets — a raw DB
    // write would test nothing).
    const flip = await adminPage.request.patch("/api/workspace/assignment/settings", {
      data: { agentConversationVisibility: "assigned" },
    });
    expect(flip.ok()).toBeTruthy();

    // No reload: the forced reconnect's resync re-reads the list under the
    // agent's NEW visibility (post-bust session) and the foreign row leaves.
    // Before the fix, the re-handshake read the stale cached visibility and
    // the socket silently rejoined the firehose — the row stayed forever.
    await expect(agentPage.getByText(foreign.contactName)).toHaveCount(0, {
      timeout: 30_000,
    });

    // And the grant direction: flip back to "team" → the row returns, again
    // with no reload.
    const unflip = await adminPage.request.patch("/api/workspace/assignment/settings", {
      data: { agentConversationVisibility: "team" },
    });
    expect(unflip.ok()).toBeTruthy();
    await expect(agentPage.getByText(foreign.contactName).first()).toBeVisible({
      timeout: 30_000,
    });
  } finally {
    await setAgentVisibility("team");
    await agentPage?.context().close();
    await db().conversation.deleteMany({ where: { id: foreign.conversationId } });
  }
});

test("workspace metadata still reaches a restricted agent live (wsmeta): a new stage appears with no reload", async ({
  browser,
  page: adminPage,
}) => {
  test.setTimeout(240_000);
  await seedRestrictedAgent();
  await setAgentVisibility("assigned");
  const stageName = `RIA Stage ${Date.now()}`;
  let stageId: string | null = null;

  let agentPage: Page | null = null;
  try {
    agentPage = await loginAs(browser, RESTRICTED_AGENT_EMAIL, RESTRICTED_AGENT_PASSWORD);
    await agentPage.goto("/inbox", { timeout: 120_000, waitUntil: "domcontentloaded" });
    // Expand the Stages section of the inbox sidebar so the catalog is on
    // screen. Client state survives router.refresh(), so the section stays
    // open when the catalog tick re-renders the RSC.
    await agentPage.getByRole("button", { name: /stages/i }).first().click();
    await agentPage.waitForTimeout(2_000); // socket connected
    await expect(agentPage.getByText(stageName)).toHaveCount(0);

    // Admin creates a stage → `team.catalog_changed` (scope: stages) → the
    // wsmeta room → the agent's use-catalog-sync runs router.refresh(). Before
    // the wsmeta room existed, catalog ticks went only to the ws: room a
    // restricted agent never joins — every catalog was frozen until reload.
    const made = await adminPage.request.post("/api/workspace/stages", {
      data: { name: stageName },
    });
    expect(made.ok()).toBeTruthy();
    stageId = ((await made.json()) as { stage?: { id: string } }).stage?.id ?? null;

    await expect(agentPage.getByText(stageName).first()).toBeVisible({ timeout: 30_000 });
  } finally {
    await setAgentVisibility("team");
    await agentPage?.context().close();
    if (stageId) {
      await adminPage.request.delete(`/api/workspace/stages/${stageId}`).catch(() => undefined);
    }
  }
});
