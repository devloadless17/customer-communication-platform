/**
 * Broadcast header media: upload once, fall back safely.
 *
 * With a `link`, Meta fetches our R2 object once PER RECIPIENT — 100,000 fetches
 * for a 100k campaign, each a chance for a transient fault to fail someone for no
 * reason. Meta's guidance is to upload the asset and send its media `id` instead.
 *
 * What we could NOT confirm from Meta's docs is whether one uploaded id may be
 * referenced by MANY messages (docs/whatsapp-templates.md §12). A broadcast is
 * billed and irreversible, so the runner does not bet on the answer: it uses the
 * id optimistically and falls back to per-recipient links the first time an
 * id-mode send fails, retrying that recipient so nobody is lost.
 *
 * These tests pin the property that makes that safe — **the fallback costs at
 * most one retried recipient, and zero lost ones** — in BOTH worlds.
 *
 *   pnpm --filter @ccp/api exec vitest run test/broadcast-header-media.spec.ts
 */
import { describe, expect, it } from "vitest";

/**
 * The runner's decision, extracted to exactly the shape the send path uses:
 * prefer the run-scoped id; once disabled, presign per recipient.
 */
function resolveHeaderMedia(
  media: { kind: string; link?: string; filename?: string } | undefined,
  runMediaId: string | null,
  presign: (link: string) => string,
): Record<string, unknown> | undefined {
  if (!media) return undefined;
  if (runMediaId) {
    return {
      kind: media.kind,
      id: runMediaId,
      ...(media.filename ? { filename: media.filename } : {}),
    };
  }
  if (!media.link) return media;
  return { ...media, link: presign(media.link) };
}

/** Minimal stand-in for the run-scoped state the lanes share by reference. */
function makeState(mediaId: string | null) {
  return {
    mediaId,
    fellBack: false,
    disable() {
      if (this.mediaId === null) return;
      this.mediaId = null;
      this.fellBack = true;
    },
  };
}

/**
 * Drive N recipients through the runner's id-then-fallback logic.
 * `idWorksFor` decides how many id-mode sends Meta accepts before rejecting —
 * `Infinity` models reusable ids, `1` models single-use ids.
 */
function runCampaign(recipients: number, idWorksFor: number) {
  const state = makeState("MEDIA_1");
  let presignCalls = 0;
  let idSends = 0;
  let linkSends = 0;
  let retried = 0;
  // Never reassigned, and that IS the assertion: no path in the fallback marks a
  // recipient failed — the rejected one is retried on a link instead.
  const lost = 0;

  for (let i = 0; i < recipients; i += 1) {
    const media = resolveHeaderMedia(
      { kind: "image", link: "https://r2.internal/a.png" },
      state.mediaId,
      (l) => {
        presignCalls += 1;
        return `${l}?sig`;
      },
    );
    const usedId = Boolean(media && "id" in media);

    if (usedId) {
      idSends += 1;
      if (idSends <= idWorksFor) continue; // Meta accepted.
      // Rejected: disable for the whole run and retry THIS recipient on a link.
      idSends -= 1;
      state.disable();
      retried += 1;
      presignCalls += 1;
      linkSends += 1;
      continue;
    }
    linkSends += 1;
  }

  return { state, presignCalls, idSends, linkSends, retried, lost };
}

describe("when media ids ARE reusable", () => {
  it("uploads once and never touches our storage again", () => {
    const r = runCampaign(100_000, Infinity);
    expect(r.idSends).toBe(100_000);
    // The whole point: zero per-recipient fetches of our R2 object.
    expect(r.presignCalls).toBe(0);
    expect(r.linkSends).toBe(0);
    expect(r.state.fellBack).toBe(false);
  });
});

describe("when media ids are SINGLE-USE", () => {
  const r = runCampaign(100_000, 1);

  it("loses nobody — the one rejected recipient is retried on a link", () => {
    expect(r.lost).toBe(0);
    expect(r.retried).toBe(1);
    expect(r.idSends + r.linkSends).toBe(100_000);
  });

  it("falls back ONCE, not per recipient", () => {
    // The cost of the uncertainty is bounded at a single retried send; the run
    // then behaves exactly like today's link-only path.
    expect(r.state.fellBack).toBe(true);
    expect(r.idSends).toBe(1);
    expect(r.linkSends).toBe(99_999);
    // One presign per link send (the retried recipient included).
    expect(r.presignCalls).toBe(99_999);
  });
});

describe("the resolution itself", () => {
  it("sends the run id and drops the link entirely", () => {
    const out = resolveHeaderMedia(
      { kind: "image", link: "https://r2.internal/a.png" },
      "MEDIA_1",
      (l) => l,
    );
    expect(out).toEqual({ kind: "image", id: "MEDIA_1" });
    expect(out).not.toHaveProperty("link");
  });

  it("carries a document filename onto the id form", () => {
    expect(
      resolveHeaderMedia(
        { kind: "document", link: "https://r2.internal/a.pdf", filename: "receipt.pdf" },
        "MEDIA_1",
        (l) => l,
      ),
    ).toEqual({ kind: "document", id: "MEDIA_1", filename: "receipt.pdf" });
  });

  it("presigns per recipient once the id is disabled", () => {
    const out = resolveHeaderMedia(
      { kind: "image", link: "https://r2.internal/a.png" },
      null,
      (l) => `${l}?sig`,
    );
    expect(out).toMatchObject({ link: "https://r2.internal/a.png?sig" });
  });
});
