/**
 * Resolve the Messenger PERSONA an agent should speak as, minting it on first use.
 *
 * Meta shows "Adam from Jasper's Market" above every message a persona sends,
 * with that person's avatar. Without it, three agents and a workflow all speak as
 * one indistinguishable Page — a thread reads as a single voice, and a handoff is
 * invisible to the customer.
 *
 * ## Lazy, because Meta says to be
 *
 * "You can create a persona quickly. It is not necessary to sync your entire
 * database of agents in advance." So there is no roster sync and no backfill: the
 * persona for (agent, Page) is created the first time that agent replies on that
 * Page, and the `@@unique([channelConnectionId, userId])` on the row is what stops
 * two concurrent first replies minting two personas.
 *
 * ## Every failure path sends as the PAGE
 *
 * This runs inside the billed send path, so it is written to be impossible to
 * fail loudly. No avatar, personas switched off, Meta refusing the create, a
 * decrypt error, a slow Graph call — all of them return `null`, and `null` means
 * "send under the Page's own identity", which is exactly what happens today. A
 * persona is an improvement to a message, never a precondition for it.
 *
 * ## Why a cache, and why it only caches HITS
 *
 * The mapping is immutable once minted, so a resolved id is cached for the
 * process lifetime of the entry. A MISS is deliberately not cached: the miss path
 * is what mints, and caching it would keep an agent voiceless for the whole TTL
 * after their persona was created by a concurrent send.
 */

import { db } from "@/lib/db";
import { toExternalAvatarUrl } from "@/lib/blob-storage";
import { TtlCache } from "@/lib/providers/config-cache";
import { createPersona } from "@/lib/providers/messenger-personas";
import type { SocialSendTarget } from "@/lib/providers/meta-social";

/** Resolved persona ids, keyed `${channelConnectionId}::${userId}`. */
const personaCache = new TtlCache<string>();

function key(channelConnectionId: string, userId: string): string {
  return `${channelConnectionId}::${userId}`;
}

/** Drop cached personas for a connection — call when its personas are managed. */
export function invalidatePersonaCache(channelConnectionId: string): void {
  personaCache.deletePrefix(`${channelConnectionId}::`);
}

/**
 * Personas are OFF unless a Page opts in.
 *
 * The switch lives in `ChannelConnection.config` rather than its own column
 * because it is a per-account preference with no query ever filtering on it —
 * the same place `verifyToken` and `appId` already live. It defaults to OFF on
 * purpose: turning it on changes what every future customer SEES in the thread,
 * and that is a decision a business makes, not one a deploy makes for them.
 */
export function personasEnabled(config: unknown): boolean {
  return (config as { personasEnabled?: unknown } | null)?.personasEnabled === true;
}

/**
 * The persona id for this agent on this Page, or null to send as the Page.
 *
 * `target` is the already-resolved send credentials — passed in rather than
 * re-loaded so this adds no credential round trip to a send that has just
 * resolved them.
 */
export async function resolvePersonaId(args: {
  workspaceId: string;
  channelConnectionId: string | null;
  userId: string | null;
  target: SocialSendTarget;
}): Promise<string | null> {
  const { workspaceId, channelConnectionId, userId } = args;
  // A workflow / broadcast / API send has no human behind it. Speaking as a named
  // person would be a lie about who is talking, so those stay the Page.
  if (!channelConnectionId || !userId) return null;

  const cached = personaCache.get(key(channelConnectionId, userId));
  if (cached) return cached;

  try {
    const existing = await db.messengerPersona.findUnique({
      where: { channelConnectionId_userId: { channelConnectionId, userId } },
      select: { externalPersonaId: true },
    });
    if (existing) {
      personaCache.set(key(channelConnectionId, userId), existing.externalPersonaId);
      return existing.externalPersonaId;
    }

    // ── First reply by this agent on this Page: mint ────────────────────────
    const user = await db.user.findFirst({
      where: { id: userId },
      select: { name: true, avatarUrl: true },
    });
    if (!user?.name?.trim()) return null;

    // Meta DOWNLOADS this URL and re-hosts the image, so it must be publicly
    // fetchable for the duration of the call — a presigned R2 URL is, and rotting
    // afterwards is harmless because Meta keeps its own copy. An agent with no
    // avatar gets no persona: `profile_picture_url` is required by the API, and a
    // stand-in image would put a face on a message that isn't theirs.
    const avatar = await toExternalAvatarUrl(userId, Boolean(user.avatarUrl));
    if (!avatar) return null;

    const persona = await createPersona(
      { name: user.name.trim(), profilePictureUrl: avatar },
      args.target,
    );

    // Losing the race is not an error: the other send already minted a persona
    // for this pair, so adopt theirs rather than keeping a duplicate. The unique
    // index is what makes this safe to reason about.
    const row = await db.messengerPersona
      .create({
        data: {
          workspaceId,
          channelConnectionId,
          userId,
          externalPersonaId: persona.id,
          name: persona.name ?? user.name.trim(),
        },
        select: { externalPersonaId: true },
      })
      .catch(async () => {
        return db.messengerPersona.findUnique({
          where: { channelConnectionId_userId: { channelConnectionId, userId } },
          select: { externalPersonaId: true },
        });
      });

    const id = row?.externalPersonaId ?? persona.id;
    personaCache.set(key(channelConnectionId, userId), id);
    return id;
  } catch (err) {
    // Deliberately swallowed to a warn: see the header. A persona improves a
    // message; it must never be able to stop one.
    console.warn(
      JSON.stringify({
        event: "messenger.persona_resolve_failed",
        severity: "info",
        workspaceId,
        channelConnectionId,
        error: err instanceof Error ? err.message : String(err),
        note: "sending under the Page's identity instead",
      }),
    );
    return null;
  }
}
