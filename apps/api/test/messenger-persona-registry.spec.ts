/**
 * Per-agent personas — the resolve-or-mint path that runs inside the billed send.
 *
 * The single property that matters here is that it CANNOT fail a send. Every
 * branch that can't produce a persona must return null, which means "speak as the
 * Page" — which is exactly what happened before personas existed.
 *
 *   pnpm --filter @ccp/api exec vitest run test/messenger-persona-registry.spec.ts
 */
import { describe, expect, it, vi } from "vitest";

import { personasEnabled } from "@/lib/providers/messenger-persona-registry";

describe("personasEnabled", () => {
  it("defaults to OFF for every shape that isn't an explicit true", () => {
    // Turning personas on changes what every future customer SEES in the thread.
    // That is a decision a business makes, not one a deploy makes for them — so
    // anything ambiguous reads as off.
    expect(personasEnabled(null)).toBe(false);
    expect(personasEnabled(undefined)).toBe(false);
    expect(personasEnabled({})).toBe(false);
    expect(personasEnabled({ personasEnabled: false })).toBe(false);
    // Not a boolean true — a JSON column can hold anything, and "true" is a
    // string someone typed, not a decision someone made.
    expect(personasEnabled({ personasEnabled: "true" })).toBe(false);
    expect(personasEnabled({ personasEnabled: 1 })).toBe(false);
  });

  it("is on only for an explicit boolean true", () => {
    expect(personasEnabled({ personasEnabled: true })).toBe(true);
  });
});

describe("resolvePersonaId never throws into the send path", () => {
  const target = {
    accountId: "PAGE_1",
    accessToken: "tok",
    graphVersion: "v26.0",
    label: "messenger",
  };

  it("returns null for a send with no human behind it", async () => {
    const { resolvePersonaId } = await import("@/lib/providers/messenger-persona-registry");
    // A workflow, a broadcast or an API key has no agent. Speaking as a named
    // person would be a lie about who is talking.
    expect(
      await resolvePersonaId({
        workspaceId: "w1",
        channelConnectionId: "c1",
        userId: null,
        target,
      }),
    ).toBeNull();
    expect(
      await resolvePersonaId({
        workspaceId: "w1",
        channelConnectionId: null,
        userId: "u1",
        target,
      }),
    ).toBeNull();
  });

  it("returns null — not a throw — when the database is unreachable", async () => {
    vi.resetModules();
    vi.doMock("@/lib/db", () => ({
      db: {
        messengerPersona: {
          findUnique: vi.fn().mockRejectedValue(new Error("connection refused")),
        },
      },
    }));
    const { resolvePersonaId } = await import("@/lib/providers/messenger-persona-registry");

    // The message is already going out; a persona is an improvement to it, never
    // a precondition. A throw here would turn a healthy reply into a failed one.
    await expect(
      resolvePersonaId({
        workspaceId: "w1",
        channelConnectionId: "c1",
        userId: "u1",
        target,
      }),
    ).resolves.toBeNull();

    vi.doUnmock("@/lib/db");
    vi.resetModules();
  });

  it("returns null when the agent has no avatar", async () => {
    vi.resetModules();
    vi.doMock("@/lib/db", () => ({
      db: {
        messengerPersona: { findUnique: vi.fn().mockResolvedValue(null) },
        // Named, but no avatar — `profile_picture_url` is required by Meta, and a
        // stand-in image would put a face on a message that isn't theirs.
        user: { findFirst: vi.fn().mockResolvedValue({ name: "Ada", avatarUrl: null }) },
      },
    }));
    const { resolvePersonaId } = await import("@/lib/providers/messenger-persona-registry");

    expect(
      await resolvePersonaId({
        workspaceId: "w1",
        channelConnectionId: "c1",
        userId: "u1",
        target,
      }),
    ).toBeNull();

    vi.doUnmock("@/lib/db");
    vi.resetModules();
  });
});
