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
   * The shared-asset rule. One object is referenced by the template's default
   * AND by every message ever sent from it, in every thread — so the
   * conversation-delete path must skip it. Pinned as the marker contract the
   * two exclusions (conversations.service `collectMediaKeys`, blob-orphan's
   * `URL_ONLY_KEY_MARKERS`) both key on.
   */
  it("a template header key is recognisable as shared, and a normal one is not", () => {
    const isShared = (key: string) => key.includes("/tpl-hdr-");
    expect(isShared("media/ws_1/2026/09/tpl-hdr-abc-banner.jpg")).toBe(true);
    // An ordinary inbound/outbound attachment is owned by its message and MUST
    // still be reclaimed when the conversation is deleted.
    expect(isShared("media/ws_1/2026/09/wamid.ABC-image.jpg")).toBe(false);
  });

  /**
   * The link is the one binding field that leaves the app — Meta fetches it and
   * it becomes an object key — so it gets the same gate every sibling send
   * schema applies, plus a read-side guard for rows written before that.
   */
  it("rejects a non-https, over-long or non-string link at parse time", () => {
    const link = (v: string) =>
      parseVariableBindings({ body: [], headerMedia: { kind: "image", link: v } })
        .headerMedia;
    expect(link("http://r2.example/x.jpg")).toBeUndefined(); // not https
    expect(link("javascript:alert(1)")).toBeUndefined();
    expect(link("/relative/path.jpg")).toBeUndefined();
    expect(link(`https://r2.example/${"a".repeat(2100)}`)).toBeUndefined(); // > 2048
    expect(link("https://r2.example/ok.jpg")).toEqual({
      kind: "image",
      link: "https://r2.example/ok.jpg",
    });
  });

  /**
   * The persisted asset must belong to the SENDING workspace. `isOwnUrl` vets
   * only the bucket host, and `/api/media/:id` scopes the message, never the
   * key — so without a team-prefix check a workspace could point a default at a
   * sibling tenant's object and read it same-origin.
   */
  it("only accepts a header key under the sending workspace's own prefix", () => {
    const accept = (key: string | null, workspaceId: string) =>
      key && key.startsWith(`media/${workspaceId}/`) ? key : null;
    expect(accept("media/ws_mine/2026/09/tpl-hdr-a.jpg", "ws_mine")).toBe(
      "media/ws_mine/2026/09/tpl-hdr-a.jpg",
    );
    expect(accept("media/ws_other/2026/09/tpl-hdr-a.jpg", "ws_mine")).toBeNull();
    expect(accept("contact-exports/ws_mine/x.csv", "ws_mine")).toBeNull();
  });

  /**
   * `mapMessage` emits the media DTO only when `mediaKind && mediaMimeType`, so
   * a row written without a mime renders NOWHERE while still consuming a
   * Files-tab slot and drawing a quoted-reply thumbnail. Write both or neither.
   */
  it("writes media columns only when the mime is known", () => {
    const columns = (media: { mimeType?: string } | null, key: string | null) =>
      key && media?.mimeType ? { mediaKind: "image", mediaKey: key, mediaMimeType: media.mimeType } : {};
    expect(columns({ mimeType: "image/jpeg" }, "media/ws/1-tpl-hdr-a.jpg")).toMatchObject({
      mediaMimeType: "image/jpeg",
    });
    // A default saved before mime capture, a /v1 or workflow send that omits
    // it: no half-media row.
    expect(columns({}, "media/ws/1-tpl-hdr-a.jpg")).toEqual({});
    expect(columns({ mimeType: "image/jpeg" }, null)).toEqual({});
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
