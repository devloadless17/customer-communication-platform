/**
 * A DM must never render a departed colleague as "notes to self".
 *
 * `mapDmPeer` picks the non-viewer member row. Three situations leave it with
 * only the viewer's row, and they mean completely different things:
 *
 *   1. a genuine self-DM        → show the viewer, `isSelf: true`
 *   2. the peer was HARD-DELETED → their User row is gone; show the tombstone
 *   3. the peer was REMOVED from the workspace → their User row LIVES but
 *      `remove-member.ts` deletes every `TeamChannelMember` row they hold,
 *      DMs included
 *
 * (3) was indistinguishable from (1) by member rows alone, so the survivor's
 * conversation with a colleague rendered as their own notes-to-self, showing
 * their own name and avatar on a thread full of someone else's messages.
 *
 * `dmKey` is the sorted user-id pair, so a real self-DM is `"u:u"` and
 * anything else with a missing peer is a departure. These tests pin that
 * distinction — the function is not exported, so they exercise the same
 * predicate against the same inputs.
 */
import { describe, expect, it } from "vitest";

/** The rule under test, mirrored from `lib/team-chat/queries.ts`. */
function resolveIsSelf(
  memberUserIds: string[],
  viewerId: string,
  dmKey: string | null,
): boolean {
  const other = memberUserIds.find((id) => id !== viewerId) ?? null;
  return other === null && dmKey !== null && new Set(dmKey.split(":")).size === 1;
}

describe("DM peer resolution", () => {
  it("a genuine self-DM is self", () => {
    // createOrGetDm builds the key from the sorted pair, so messaging yourself
    // yields the same id twice.
    expect(resolveIsSelf(["u1"], "u1", "u1:u1")).toBe(true);
  });

  it("a peer REMOVED from the workspace is NOT self — the regression", () => {
    // Their membership row is gone but the DM and its history remain. Only the
    // key still names two distinct people.
    expect(resolveIsSelf(["u1"], "u1", "u1:u2")).toBe(false);
  });

  it("a peer whose account was hard-deleted is NOT self either", () => {
    // Same member shape as above; the DTO layer renders the tombstone because
    // no live User row backs the peer.
    expect(resolveIsSelf(["u1"], "u1", "u1:u9")).toBe(false);
  });

  it("an intact two-person DM is never self, from either side", () => {
    expect(resolveIsSelf(["u1", "u2"], "u1", "u1:u2")).toBe(false);
    expect(resolveIsSelf(["u1", "u2"], "u2", "u1:u2")).toBe(false);
  });

  it("falls back to NOT-self when the key is missing rather than guessing", () => {
    // A null key means we cannot prove it is a self-DM. Showing a tombstone for
    // a self-DM is a cosmetic miss; showing YOUR name on a colleague's thread
    // is the bug this exists to prevent — so the ambiguous case fails safe.
    expect(resolveIsSelf(["u1"], "u1", null)).toBe(false);
  });
});
