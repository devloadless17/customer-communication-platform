// BSUID cross-portfolio send guard.
//
// A BSUID is scoped to ONE business portfolio: "if you have multiple
// portfolios, your API requests will fail if you are attempting to message a
// BSUID that is scoped to a different portfolio" (BSUID reference). Inbox
// REPLIES can't hit this — a thread's replies go out the connection that
// received the inbound, the same portfolio that issued the stored bsuid — so
// the guard is wired only where the SENDING account is chosen independently of
// the thread: template sends (workflow / v1 / broadcast paths).
//
// Resolution: when both sides are KNOWN and differ, prefer the contact's
// parent BSUID ("US.ENT.…" — Meta's cross-portfolio key) as the destination;
// with none stored, refuse locally with an actionable error instead of burning
// the call on Meta's guaranteed rejection. An UNKNOWN side (legacy rows,
// portfolio not yet linked) passes through untouched — Meta remains the
// authority and its rejection is still mapped by meta-send-error.

import { db } from "@/lib/db";
import type { ResolvedChannel } from "@/lib/providers/channel";

export class BsuidPortfolioMismatchError extends Error {
  constructor() {
    super(
      "This contact's WhatsApp id belongs to a different business portfolio than the sending number — send from a number in the portfolio this conversation came in on.",
    );
    this.name = "BsuidPortfolioMismatchError";
  }
}

// WABA → portfolio rarely changes; a short process-local cache keeps the guard
// off the hot path's DB budget (same posture as the provider config cache).
const portfolioCache = new Map<string, { portfolioId: string | null; at: number }>();
const PORTFOLIO_CACHE_TTL_MS = 5 * 60_000;

async function portfolioOfWaba(wabaAccountId: string): Promise<string | null> {
  const hit = portfolioCache.get(wabaAccountId);
  if (hit && Date.now() - hit.at < PORTFOLIO_CACHE_TTL_MS) return hit.portfolioId;
  const waba = await db.whatsappBusinessAccount.findUnique({
    where: { id: wabaAccountId },
    select: { portfolioId: true },
  });
  const portfolioId = waba?.portfolioId ?? null;
  portfolioCache.set(wabaAccountId, { portfolioId, at: Date.now() });
  return portfolioId;
}

export async function applyBsuidPortfolioGuard(
  channel: ResolvedChannel,
  contact: { bsuidPortfolioId: string | null; parentBsuid: string | null },
  sendConfig: { wabaAccountId?: string },
): Promise<ResolvedChannel> {
  if (!channel.viaBsuid) return channel;
  if (!contact.bsuidPortfolioId || !sendConfig.wabaAccountId) return channel;
  const sendingPortfolioId = await portfolioOfWaba(sendConfig.wabaAccountId);
  if (!sendingPortfolioId || sendingPortfolioId === contact.bsuidPortfolioId) {
    return channel;
  }
  if (contact.parentBsuid) return { ...channel, to: contact.parentBsuid };
  throw new BsuidPortfolioMismatchError();
}
