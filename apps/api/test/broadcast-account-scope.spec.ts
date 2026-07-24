/**
 * Broadcast audience scoping to the SENDING account.
 *
 * A workspace can hold several accounts on one channel (WhatsApp numbers under a
 * portfolio, Pages, IG handles). Broadcasting from account B to a contact who has
 * only ever talked to account A shows them a sender they don't recognise, and
 * their reply opens a SEPARATE thread on B — the customer's history looks split.
 * So the default audience excludes other accounts' contacts.
 *
 * The trap this file exists for: **"belongs to another account" is not the same
 * as "isn't on this account".** An imported or manually-added contact has NO
 * conversation at all until someone messages them — and cold outreach to an
 * imported list is the commonest broadcast there is. Filtering to "has a
 * conversation on THIS account" silently empties exactly that campaign.
 *
 *   pnpm --filter @ccp/api exec vitest run test/broadcast-account-scope.spec.ts
 */
import { describe, expect, it } from "vitest";

/** The service's rule, in isolation: drop only contacts owned by ANOTHER account. */
function scopeToAccount(
  recipientIds: string[],
  conversations: Array<{ contactId: string; channelConnectionId: string | null }>,
  sendingAccountId: string,
): { kept: string[]; dropped: number } {
  const foreign = new Set(
    conversations
      .filter(
        (c) => c.channelConnectionId !== null && c.channelConnectionId !== sendingAccountId,
      )
      .map((c) => c.contactId),
  );
  return {
    kept: recipientIds.filter((id) => !foreign.has(id)),
    dropped: foreign.size,
  };
}

const ACCOUNT_A = "conn_a";
const ACCOUNT_B = "conn_b";

describe("contacts with no conversation yet", () => {
  it("KEEPS an imported contact — the whole point of a cold broadcast", () => {
    // No conversation row exists for them at all. The earlier "must be on this
    // account" filter dropped every one and reported an empty audience.
    const r = scopeToAccount(["imported_1", "imported_2"], [], ACCOUNT_A);
    expect(r.kept).toEqual(["imported_1", "imported_2"]);
    expect(r.dropped).toBe(0);
  });

  it("keeps a pre-multi-account conversation that carries no account", () => {
    // Conversations that predate multi-account have a null connection id, so
    // they belong to nobody in particular and stay reachable from any account.
    const r = scopeToAccount(
      ["legacy"],
      [{ contactId: "legacy", channelConnectionId: null }],
      ACCOUNT_A,
    );
    expect(r.kept).toEqual(["legacy"]);
  });
});

describe("contacts owned by another account", () => {
  it("drops them, and only them", () => {
    const r = scopeToAccount(
      ["mine", "theirs", "fresh"],
      [
        { contactId: "mine", channelConnectionId: ACCOUNT_A },
        { contactId: "theirs", channelConnectionId: ACCOUNT_B },
      ],
      ACCOUNT_A,
    );
    expect(r.kept).toEqual(["mine", "fresh"]);
    expect(r.dropped).toBe(1);
  });

  it("counts the drop so the empty-audience message can explain itself", () => {
    // "None of these contacts have messaged this number — 2 belong to another
    // of your accounts" is actionable; "empty audience" is not.
    const r = scopeToAccount(
      ["a", "b"],
      [
        { contactId: "a", channelConnectionId: ACCOUNT_B },
        { contactId: "b", channelConnectionId: ACCOUNT_B },
      ],
      ACCOUNT_A,
    );
    expect(r.kept).toEqual([]);
    expect(r.dropped).toBe(2);
  });
});
