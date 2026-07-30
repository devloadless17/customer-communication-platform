/**
 * When does the inbox NAME a channel account, and when does it offer a CHOICE
 * between accounts?
 *
 * Two predicates that differ by one character and answer different questions:
 *
 *   showAccountFor  >= 1   attribution — "which of my numbers is this thread on"
 *   hasMultipleFor  >  1   a filter — "narrow the inbox to one account"
 *
 * Attribution originally required a SECOND account, on the theory that it is purely
 * a disambiguator. That made the account concept first appear on the day a
 * workspace connected a second number — the moment it became load-bearing, and so
 * the worst possible moment to be learning what the chip means. It now shows from
 * the first account.
 *
 * The filter deliberately did NOT move with it. They were ONE predicate, so
 * relaxing attribution silently grew a one-entry "pick an account" list in the
 * inbox sidebar — clutter that the section's own docstring rules out. That coupling
 * is the reason this file exists: the split is one character wide and reads like
 * duplication, so anything that "simplifies" the two back together should fail here.
 *
 *   pnpm --filter @ccp/web exec vitest run test/account-visibility.spec.ts
 */
import { describe, expect, it } from "vitest";

import { accountVisibility } from "@/features/channels/lib/account-visibility";
import type { ChannelAccountDirectoryEntry } from "@/lib/api/queries";

function account(
  id: string,
  channel: ChannelAccountDirectoryEntry["channel"],
): ChannelAccountDirectoryEntry {
  return {
    id,
    channel,
    name: id,
    providerName: null,
    isDefault: false,
    isActive: true,
    needsReconnect: false,
  };
}

describe("a channel with ONE account", () => {
  const { showAccountFor, hasMultipleFor } = accountVisibility([account("wa1", "whatsapp")]);

  it("IS named — the agent should see which number they are on from the start", () => {
    expect(showAccountFor("whatsapp")).toBe(true);
  });

  it("offers no CHOICE — a one-entry account filter is clutter", () => {
    expect(hasMultipleFor("whatsapp")).toBe(false);
  });
});

describe("a channel with TWO accounts", () => {
  const { showAccountFor, hasMultipleFor } = accountVisibility([
    account("wa1", "whatsapp"),
    account("wa2", "whatsapp"),
  ]);

  it("is both named and filterable", () => {
    expect(showAccountFor("whatsapp")).toBe(true);
    expect(hasMultipleFor("whatsapp")).toBe(true);
  });
});

describe("a channel with NO accounts", () => {
  const { showAccountFor, hasMultipleFor } = accountVisibility([account("wa1", "whatsapp")]);

  it("is neither named nor filterable — there is nothing to name", () => {
    // Also the shape a FAILED directory read takes, which must never render an
    // empty chip.
    expect(showAccountFor("instagram")).toBe(false);
    expect(hasMultipleFor("instagram")).toBe(false);
  });

  it("treats an unknown channel as nothing to name", () => {
    expect(showAccountFor(undefined)).toBe(false);
    expect(hasMultipleFor(undefined)).toBe(false);
  });
});

describe("the count is PER CHANNEL, not across the workspace", () => {
  it("does not let two WhatsApp numbers make a lone Instagram handle filterable", () => {
    // The bug this guards: totalling the directory would offer an account filter
    // for a channel that has exactly one account.
    const { showAccountFor, hasMultipleFor } = accountVisibility([
      account("wa1", "whatsapp"),
      account("wa2", "whatsapp"),
      account("ig1", "instagram"),
    ]);

    expect(hasMultipleFor("whatsapp")).toBe(true);
    expect(hasMultipleFor("instagram")).toBe(false);
    // …but the lone handle is still NAMED.
    expect(showAccountFor("instagram")).toBe(true);
  });
});
