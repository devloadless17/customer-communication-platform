/**
 * Template DEFAULT header media — `variableBindings.headerMedia`.
 *
 * Meta requires a header asset on EVERY send of a media-header template. The
 * `header_handle` supplied at creation is only the sample its reviewers looked
 * at ("The example asset will be reviewed as part of template review"), never a
 * send-time fallback — so a business whose promo template always carries the
 * same banner was re-attaching that banner in every single conversation.
 *
 * The properties that carry the risk:
 *
 *   1. **The default survives the bindings round-trip.** It rides the same
 *      JSON column as the variable bindings, which the editor rewrites wholesale
 *      on every save — a normalize() that dropped unknown keys would silently
 *      clear the saved asset, and Meta cannot give it back.
 *   2. **A caller-supplied asset always wins.** The default is the answer to
 *      "the caller said nothing", never an override of a one-off attachment —
 *      getting that backwards sends last month's banner over an agent's
 *      deliberate choice.
 *   3. **A default of the WRONG KIND is not used.** A template edited from an
 *      IMAGE header to a DOCUMENT one leaves a stale default behind; using it
 *      would turn an actionable "attach one" into a send Meta rejects.
 *   4. **No Meta media id is ever stored.** Those expire after 30 days and are
 *      scoped to the phone number that uploaded them, so a stored one would rot
 *      and would be wrong for a sibling number in the same workspace.
 *
 *   pnpm --filter @ccp/api exec vitest run test/template-default-header-media.spec.ts
 */
import { describe, expect, it } from "vitest";

import { parseVariableBindings } from "@ccp/shared/template-bindings";

/** The editor's own normalizer — the save path every drawer edit goes through. */
function normalizeLikeEditor(src: ReturnType<typeof parseVariableBindings>) {
  // Mirrors variable-bindings-editor.tsx: body slots are rebuilt from the
  // template's placeholder count, and anything that isn't a text slot must be
  // carried through untouched.
  return {
    body: src.body,
    ...(src.header ? { header: src.header } : {}),
    ...(src.headerMedia ? { headerMedia: src.headerMedia } : {}),
  };
}

describe("template default header media", () => {
  it("parses a saved default off the bindings column", () => {
    const parsed = parseVariableBindings({
      body: [],
      headerMedia: { kind: "image", link: "https://r2.example/media/ws/banner.jpg" },
    });
    expect(parsed.headerMedia).toEqual({
      kind: "image",
      link: "https://r2.example/media/ws/banner.jpg",
    });
  });

  it("keeps a document default's filename — it is what the recipient sees", () => {
    const parsed = parseVariableBindings({
      body: [],
      headerMedia: { kind: "document", link: "https://r2.example/x.pdf", filename: "Menu.pdf" },
    });
    expect(parsed.headerMedia?.filename).toBe("Menu.pdf");
  });

  it("survives the editor's normalize — a save must not clear it", () => {
    const stored = {
      body: [{ label: "first_name", source: { kind: "manual" } }],
      headerMedia: { kind: "image", link: "https://r2.example/banner.jpg" },
    };
    const round = normalizeLikeEditor(parseVariableBindings(stored));
    expect(round.headerMedia).toEqual({ kind: "image", link: "https://r2.example/banner.jpg" });
    // …and the text bindings beside it are untouched.
    expect(round.body[0]?.label).toBe("first_name");
  });

  it("degrades to no-default on a malformed or empty value, never throwing", () => {
    for (const bad of [
      { body: [], headerMedia: null },
      { body: [], headerMedia: "banner.jpg" },
      { body: [], headerMedia: { kind: "image" } }, // no link
      { body: [], headerMedia: { kind: "image", link: "   " } }, // blank link
      { body: [], headerMedia: { kind: "audio", link: "https://r2.example/a.ogg" } }, // not a header format
      { body: [], headerMedia: [] },
    ]) {
      expect(parseVariableBindings(bad).headerMedia).toBeUndefined();
    }
  });

  it("stores no Meta media id — ids expire in 30 days and are per-number", () => {
    const parsed = parseVariableBindings({
      body: [],
      headerMedia: { kind: "image", link: "https://r2.example/b.jpg", id: "2871834006348767" },
    });
    expect(parsed.headerMedia).toEqual({ kind: "image", link: "https://r2.example/b.jpg" });
    expect(parsed.headerMedia).not.toHaveProperty("id");
  });

  /**
   * The resolution rule the send path applies, stated as data. Kept in lockstep
   * with `resolvedHeaderMedia` in lib/messaging/send-template-internal.ts.
   */
  it("resolves caller-over-default, and ignores a default of the wrong kind", () => {
    const resolve = (
      supplied: { kind: string; link?: string; id?: string } | undefined,
      stored: { kind: string; link: string },
      headerKind: "image" | "video" | "document" | null,
    ) => {
      const fallback = parseVariableBindings({ body: [], headerMedia: stored }).headerMedia;
      return supplied ?? (fallback && fallback.kind === headerKind ? fallback : undefined);
    };
    const saved = { kind: "image", link: "https://r2.example/saved.jpg" };

    // Nothing supplied → the default fills in.
    expect(resolve(undefined, saved, "image")).toEqual(saved);

    // A one-off attachment wins over the default.
    expect(resolve({ kind: "image", link: "https://r2.example/one-off.jpg" }, saved, "image")).toEqual(
      { kind: "image", link: "https://r2.example/one-off.jpg" },
    );

    // Header format changed under a stale default → no default, so the caller
    // gets the actionable "attach one" rather than a rejection from Meta.
    expect(resolve(undefined, saved, "document")).toBeUndefined();

    // A template with no media header never grows one from a stale default.
    expect(resolve(undefined, saved, null)).toBeUndefined();
  });
});
