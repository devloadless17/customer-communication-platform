"use client";

import { tokenizeBody } from "@/lib/team-chat/mentions";
import { cn } from "@/lib/utils";

/**
 * Renders a team-chat message body. Plain text passes through; `@[Name](id)`
 * tokens become highlighted chips. When `highlightUserId` matches a mention,
 * its chip uses an accent style so the recipient sees "Bob mentioned me"
 * at a glance.
 *
 * Whitespace preservation: `whitespace-pre-wrap` keeps newlines without
 * forcing a heavyweight Markdown pipeline — agents typing multi-line
 * notes are the dominant case.
 */
export function BodyRenderer({
  body,
  highlightUserId,
}: {
  body: string;
  highlightUserId?: string;
}) {
  const tokens = tokenizeBody(body);
  return (
    <span className="whitespace-pre-wrap break-words text-sm leading-relaxed">
      {tokens.map((tok, i) =>
        tok.kind === "text" ? (
          <span key={i}>{tok.text}</span>
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
