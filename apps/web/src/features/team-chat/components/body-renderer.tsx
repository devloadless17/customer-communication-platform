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
 * Whitespace preservation: `whitespace-pre-wrap` keeps newlines without
 * forcing a heavyweight Markdown pipeline — agents typing multi-line
 * notes are the dominant case.
 */
export function BodyRenderer({
  body,
  highlightUserId,
  searchQuery,
}: {
  body: string;
  highlightUserId?: string;
  /** Active search query — when non-empty, matching substrings render
   *  with a `<mark>` highlight inside the bubble. Whitespace is trimmed by
   *  the caller; this component treats falsy/empty as "no highlight". */
  searchQuery?: string | null;
}) {
  const tokens = tokenizeBody(body);
  const q = searchQuery?.trim() ?? "";
  return (
    <span className="whitespace-pre-wrap wrap-break-words text-sm leading-relaxed">
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
            @{tok.name}
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
