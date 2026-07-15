import { db } from "@/lib/db";

/**
 * Atomic mutual-exclusion arbiter (correction #3). A ConversationAutomationClaim
 * row with a unique (teamId, inboundMessageId) means exactly one owner may
 * answer a given inbound message. The INSERT is the gate: the first writer wins,
 * every other writer hits P2002 and must stand down.
 *
 * This also dedupes at-least-once delivery — a redelivered message.received
 * cannot produce a second claim, so it cannot produce a second reply
 * (correction #15, cases 1 & 4).
 */

export type AutomationOwner = "native_ai" | "autopilot" | "workflow";

/** Try to claim the inbound message. Returns true iff THIS call won the claim. */
export async function claimInbound(
  teamId: string,
  conversationId: string,
  inboundMessageId: string,
  owner: AutomationOwner = "native_ai",
): Promise<boolean> {
  try {
    await db.conversationAutomationClaim.create({
      data: { teamId, conversationId, inboundMessageId, owner },
    });
    return true;
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") return false; // already claimed
    throw err;
  }
}

export async function getClaim(teamId: string, inboundMessageId: string) {
  return db.conversationAutomationClaim.findUnique({
    where: { teamId_inboundMessageId: { teamId, inboundMessageId } },
  });
}

/**
 * Whether the LEGACY n8n autopilot owns automation for this team. Read-only —
 * we never mutate autopilot state. When it's on, the native assistant stands
 * down entirely for the team (belt-and-suspenders on top of the claim row) so
 * the two systems can never both answer.
 */
export async function legacyAutopilotOwnsTeam(teamId: string): Promise<boolean> {
  const team = await db.team.findUnique({
    where: { id: teamId },
    select: { aiAutopilotEnabled: true },
  });
  return team?.aiAutopilotEnabled === true;
}
