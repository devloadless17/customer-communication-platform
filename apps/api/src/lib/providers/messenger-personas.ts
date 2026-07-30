/**
 * PERSONAS — put the agent's own name and face on the message instead of the
 * Page's.
 *
 * Meta: "When you introduce a persona into a conversation, the persona's profile
 * picture is shown and all messages sent by the persona are accompanied by an
 * annotation above the message that states the persona name and the business it
 * represents" — i.e. "Adam from Jasper's Market".
 *
 * For a SHARED INBOX this is not cosmetic. Without it, three agents and a
 * workflow all speak to the customer as one indistinguishable Page, so a thread
 * reads as a single schizophrenic voice and a handoff is invisible. It is the
 * closest Messenger gets to the named-agent identity WhatsApp doesn't have at
 * all.
 *
 * ## Four things about this API that will bite
 *
 *  1. `persona_id` is a TOP-LEVEL send field, a sibling of `message` rather than
 *     a property of it. Nested inside `message` it is silently ignored: the send
 *     succeeds, returns a message id, and goes out as the Page. There is no error
 *     to notice, which is why every send helper here takes it explicitly.
 *  2. Only `typing_on` and `typing_off` accept a persona. `mark_seen` does not —
 *     a read receipt is the Page's, not a person's.
 *  3. Deleting is a SOFT delete: "messages previously sent by this persona
 *     continue to appear in the conversation history, but the persona can no
 *     longer send new messages." So deleting an agent's persona when they leave
 *     is safe and does not rewrite history.
 *  4. Meta DOWNLOADS `profile_picture_url` and re-hosts it, so the URL must be
 *     publicly reachable at create time and may then rot without consequence.
 *     Max 8 MB.
 *
 * ## Not stored locally
 *
 * There is no `Persona` table. The list is read from Meta, and the persona id is
 * what a send needs — mirroring it would create a second truth that drifts the
 * moment someone deletes a persona in another tool, for no gain. If per-agent
 * personas are later minted automatically on first send, THAT is when a mapping
 * table (userId → personaId, per Page) earns its place.
 */

import {
  GRAPH_BASE,
  graphDelete,
  graphGetJson,
  graphPostJson,
} from "@/lib/providers/meta-graph";
import type { SocialSendTarget } from "@/lib/providers/meta-social";

/** Meta's documented cap on a persona's display name. */
export const MAX_PERSONA_NAME_CHARS = 50;
/** Meta's cap on the profile image it downloads and re-hosts. */
export const MAX_PERSONA_IMAGE_BYTES = 8 * 1024 * 1024;

export interface MessengerPersona {
  id: string;
  name: string | null;
  /** Meta's re-hosted copy, not the URL that was submitted. */
  profilePictureUrl: string | null;
}

function personaFrom(row: Record<string, unknown>): MessengerPersona | null {
  const id = typeof row.id === "string" ? row.id : null;
  if (!id) return null;
  return {
    id,
    name: typeof row.name === "string" ? row.name : null,
    profilePictureUrl:
      typeof row.profile_picture_url === "string" ? row.profile_picture_url : null,
  };
}

/**
 * Every persona on the Page.
 *
 * Cursor-paginated by Meta. We follow `paging.cursors.after` to completion rather
 * than returning the first page: a workspace's personas map to its AGENTS, the
 * list is small and bounded by headcount, and a truncated list would silently
 * hide the very teammate someone is trying to send as. The loop is capped anyway
 * so a pathological `after` cursor can't spin.
 */
export async function listPersonas(opts: SocialSendTarget): Promise<MessengerPersona[]> {
  const out: MessengerPersona[] = [];
  let after: string | undefined;
  // 20 pages of Meta's default page size is far beyond any real agent roster;
  // the bound exists so a server-side paging bug can't become an infinite loop.
  for (let page = 0; page < 20; page++) {
    const qs = new URLSearchParams({ fields: "id,name,profile_picture_url" });
    if (after) qs.set("after", after);
    const res = await graphGetJson(
      `${GRAPH_BASE}/${opts.graphVersion}/${encodeURIComponent(opts.accountId)}/personas?${qs}`,
      opts.accessToken,
      { retry: true },
      opts.appSecret,
    );
    const data = Array.isArray(res.data) ? (res.data as Array<Record<string, unknown>>) : [];
    for (const row of data) {
      const p = personaFrom(row);
      if (p) out.push(p);
    }
    const paging = res.paging as { cursors?: { after?: unknown }; next?: unknown } | undefined;
    const nextCursor =
      typeof paging?.cursors?.after === "string" ? paging.cursors.after : undefined;
    // `cursors.after` is present on the LAST page too — only `paging.next` tells
    // you another page exists. Following the cursor alone re-requests the final
    // page forever.
    if (!nextCursor || typeof paging?.next !== "string") break;
    after = nextCursor;
  }
  return out;
}

/** One persona by id. Null when it doesn't exist (or was soft-deleted). */
export async function getPersona(
  personaId: string,
  opts: SocialSendTarget,
): Promise<MessengerPersona | null> {
  try {
    const res = await graphGetJson(
      `${GRAPH_BASE}/${opts.graphVersion}/${encodeURIComponent(personaId)}?fields=id,name,profile_picture_url`,
      opts.accessToken,
      { retry: true },
      opts.appSecret,
    );
    return personaFrom(res);
  } catch {
    return null;
  }
}

/**
 * Create a persona. Returns its id — the value a send needs.
 *
 * The name is capped at Meta's 50 characters rather than rejected, because the
 * caller is usually passing a real person's display name and truncating "Alexandra
 * Featherstonehaugh-Smythe" is better than refusing to create her persona.
 */
export async function createPersona(
  args: { name: string; profilePictureUrl: string },
  opts: SocialSendTarget,
): Promise<MessengerPersona> {
  const name = args.name.trim().slice(0, MAX_PERSONA_NAME_CHARS);
  if (!name) throw new Error("createPersona: name is required");
  const res = await graphPostJson(
    `${GRAPH_BASE}/${opts.graphVersion}/${encodeURIComponent(opts.accountId)}/personas`,
    opts.accessToken,
    { name, profile_picture_url: args.profilePictureUrl },
    opts.appSecret,
  );
  const id = typeof res.id === "string" ? res.id : "";
  if (!id) throw new Error(`${opts.label} createPersona: response missing id`);
  return { id, name, profilePictureUrl: args.profilePictureUrl };
}

/**
 * Delete a persona. SOFT — history is preserved and only future sends are
 * blocked, so this is the correct call when an agent leaves.
 */
export async function deletePersona(
  personaId: string,
  opts: SocialSendTarget,
): Promise<void> {
  await graphDelete(
    `${GRAPH_BASE}/${opts.graphVersion}/${encodeURIComponent(personaId)}`,
    opts.accessToken,
    opts.appSecret,
  );
}

/**
 * A typing indicator attributed to a persona.
 *
 * Separate from the ordinary `sendSocialSenderAction` because the persona rules
 * differ by ACTION, not just by argument: Meta supports `persona_id` on
 * `typing_on`/`typing_off` only. Routing `mark_seen` through here would send a
 * field the endpoint ignores and imply an attribution that does not exist.
 */
export async function sendPersonaTyping(
  args: { to: string; personaId: string; active: boolean },
  opts: SocialSendTarget,
): Promise<void> {
  await graphPostJson(
    `${GRAPH_BASE}/${opts.graphVersion}/${opts.accountId}/messages`,
    opts.accessToken,
    {
      recipient: { id: args.to },
      sender_action: args.active ? "typing_on" : "typing_off",
      persona_id: args.personaId,
    },
    opts.appSecret,
  );
}
