"use client";

import { tokenizeBody } from "@ccp/shared/team-chat/mentions";
import { cn } from "@ccp/shared/utils";

/**
 * Renders a team-chat message body. Plain text passes through; `@[Name](id)`
 * tokens become highlighted chips. When `highlightUserId` matches a mention,
 * its chip uses an accent style so the recipient sees "Bob mentioned me"
 * at a glance. When `searchQuery` is non-empty, case-insensitive substring
 * matches inside text tokens are wrapped in `<mark>` so the user can see
 * matches in context — same WhatsApp-style highlight the inbox does.
 *
 * Mention chip label resolution: the name INSIDE the markup (`@[Name](id)`)
 * is authored by the sender and never validated server-side, so a teammate
 * could hand-type `@[Alice](bobs-id)` and the chip would read "Alice" while
 * Bob gets pinged — a display-spoofing / misattribution vector. We resolve
 * the chip label from the canonical team-members map (`displayNameById`) by
 * userId, falling back to the authored name only for users who have since
 * left the team (no map entry). This also keeps chips fresh after a rename.
 *
 * Whitespace preservation: `whitespace-pre-wrap` keeps newlines without
 * forcing a heavyweight Markdown pipeline — agents typing multi-line
 * notes are the dominant case.
 */
export function BodyRenderer({
  body,
  highlightUserId,
  searchQuery,
  displayNameById,
}: {
  body: string;
  highlightUserId?: string;
  /** Active search query — when non-empty, matching substrings render
   *  with a `<mark>` highlight inside the bubble. Whitespace is trimmed by
   *  the caller; this component treats falsy/empty as "no highlight". */
  searchQuery?: string | null;
  /** Canonical userId → name map (team roster). Used to render mention chip
   *  labels authoritatively instead of trusting the authored name. */
  displayNameById?: Map<string, string>;
}) {
  const tokens = tokenizeBody(body);
  const q = searchQuery?.trim() ?? "";
  return (
    // `wrap-break-word` — SINGULAR. The plural spelling isn't a Tailwind v4
    // utility, so it emitted no CSS at all and a long unbroken string (a pasted
    // URL, an id) ran straight out of the message column. Every other surface
    // in the app spells it correctly; this one was the outlier.
    <span className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed">
      {tokens.map((tok, i) =>
        tok.kind === "text" ? (
          <span key={i}>
            {q ? <HighlightedText text={tok.text} query={q} /> : tok.text}
          </span>
        ) : (
          <span
            key={i}
            className={cn(
              "rounded px-1 font-medium",
              tok.userId === highlightUserId
                ? "bg-amber-500/20 text-amber-900 dark:text-amber-200"
                : "bg-primary/10 text-primary",
            )}
          >
            @{displayNameById?.get(tok.userId) ?? tok.name}
          </span>
        ),
      )}
    </span>
  );
}

/**
 * Wraps every case-insensitive occurrence of `query` inside `text` with a
 * `<mark>` element. Plain string slicing — no regex — so user input with
 * regex metacharacters can't escape into the matcher or cause ReDoS.
 */
function HighlightedText({ text, query }: { text: string; query: string }) {
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const parts: Array<{ text: string; match: boolean }> = [];
  let cursor = 0;
  while (cursor < text.length) {
    const idx = lower.indexOf(q, cursor);
    if (idx === -1) {
      parts.push({ text: text.slice(cursor), match: false });
      break;
    }
    if (idx > cursor) parts.push({ text: text.slice(cursor, idx), match: false });
    parts.push({ text: text.slice(idx, idx + q.length), match: true });
    cursor = idx + q.length;
  }
  return (
    <>
      {parts.map((p, i) =>
        p.match ? (
          <mark
            key={i}
            className="rounded bg-yellow-200/80 px-0.5 text-foreground dark:bg-yellow-500/30"
          >
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}
