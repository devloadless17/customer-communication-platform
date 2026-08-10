import type { Browser, Page } from "@playwright/test";
import bcrypt from "bcrypt";

import { E2E_APP_ORG_ID, E2E_APP_WS_ID, db } from "./db";

/**
 * Shared fixtures for RESTRICTED-agent realtime specs (ticket-realtime,
 * restricted-inbox-realtime): a real agent with a password who logs in via the
 * real /login form in a second browser context, while the admin acts over
 * HTTP. Every assertion in those specs is about the agent's SCREEN changing
 * without a reload — which is why these are real logins, not storageState.
 */

export const RESTRICTED_AGENT_EMAIL = "e2e-restricted-agent@loadless.test";
export const RESTRICTED_AGENT_PASSWORD = "loadless";

export async function seedRestrictedAgent(): Promise<{ userId: string }> {
  const d = db();
  const passwordHash = await bcrypt.hash(RESTRICTED_AGENT_PASSWORD, 10);
  const user = await d.user.upsert({
    where: { email: RESTRICTED_AGENT_EMAIL },
    create: {
      organizationId: E2E_APP_ORG_ID,
      name: "E2E Restricted Agent",
      email: RESTRICTED_AGENT_EMAIL,
      emailVerified: true,
    },
    update: { organizationId: E2E_APP_ORG_ID, deactivatedAt: null, emailVerified: true },
  });
  await d.workspaceMember.upsert({
    where: { userId_workspaceId: { userId: user.id, workspaceId: E2E_APP_WS_ID } },
    create: { userId: user.id, workspaceId: E2E_APP_WS_ID, role: "agent" },
    update: { role: "agent" },
  });
  await d.account.upsert({
    where: {
      providerId_accountId: { providerId: "credential", accountId: RESTRICTED_AGENT_EMAIL },
    },
    create: {
      userId: user.id,
      providerId: "credential",
      accountId: RESTRICTED_AGENT_EMAIL,
      password: passwordHash,
    },
    update: { password: passwordHash, userId: user.id },
  });
  return { userId: user.id };
}

/** Set the workspace's agent visibility. Callers restore in `finally`. */
export async function setAgentVisibility(mode: "team" | "assigned"): Promise<void> {
  await db().workspace.update({
    where: { id: E2E_APP_WS_ID },
    data: { agentConversationVisibility: mode },
  });
}

/** A conversation to act on — seeded, not scavenged: the shared dev DB is
 *  wiped by other suites, and a spec that skips when the pantry is empty is a
 *  spec that silently stops guarding. */
export async function seedConversation(
  namePrefix = "RT Contact",
): Promise<{ conversationId: string; contactName: string }> {
  const d = db();
  const stamp = Date.now();
  const contactName = `${namePrefix} ${stamp}`;
  const contact = await d.contact.create({
    data: {
      workspaceId: E2E_APP_WS_ID,
      name: contactName,
      phoneNumber: `+96170${String(stamp).slice(-6)}`,
      identityChannel: "whatsapp",
    },
    select: { id: true },
  });
  const convo = await d.conversation.create({
    data: { workspaceId: E2E_APP_WS_ID, contactId: contact.id, channel: "whatsapp" },
    select: { id: true },
  });
  return { conversationId: convo.id, contactName };
}

export async function loginAs(
  browser: Browser,
  email: string,
  password: string,
): Promise<Page> {
  const context = await browser.newContext({ storageState: undefined });
  const page = await context.newPage();
  await page.goto("/login", { timeout: 120_000, waitUntil: "domcontentloaded" });
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await Promise.all([
    page.waitForURL(/\/(inbox|tickets)/, { timeout: 60_000 }),
    // Scoped to the password form — the Google button is a submit in its own
    // form ABOVE it (same trap auth.setup.ts documents).
    page.locator('form:has(input[name="password"]) button[type="submit"]').click(),
  ]);
  return page;
}
