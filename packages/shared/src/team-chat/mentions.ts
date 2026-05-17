/**
 * Mention encoding for team-chat messages.
 *
 * Wire format: a mention is encoded inline in the body as
 *   `@[Display Name](userId)`
 *
 * Why inline encoding: search, copy-paste, plain-text previews, push
 * notifications, and the channel-list `lastMessagePreview` all keep working
 * without any joined-table lookup. The TeamChannelMention rows are the
 * STRUCTURED INDEX for "show me mentions of user X" — fast, deduped, and
 * useful for unread-mention badges — but the human-readable display is
 * sourced from the body itself.
 *
 * Composer wraps inserted mentions in this format. The renderer parses
 * matching tokens back into rich chips. Anything else in the body renders
 * as plain text.
 */

const MENTION_PATTERN = /@\[([^\]]+)\]\(([a-zA-Z0-9_-]+)\)/g;

export interface MentionToken {
  /** The display name as authored. May be stale if the user renamed since. */
  name: string;
  userId: string;
  /** Character offsets in the source body. */
  start: number;
  end: number;
}

/**
 * Walk the body and return all `@[Name](id)` tokens in source order. Does
 * NOT validate the ids against the team — that's the job of the route
 * handler (we don't want this util pulling in `db`).
 */
export function parseMentions(body: string): MentionToken[] {
  const out: MentionToken[] = [];
  MENTION_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MENTION_PATTERN.exec(body)) !== null) {
    out.push({
      name: m[1]!,
      userId: m[2]!,
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return out;
}

/**
 * Strip mention markup back to `@Name` for previews / notifications. The
 * userId disappears; the name stays. Idempotent on plain text.
 */
export function stripMentionMarkup(body: string): string {
  return body.replace(MENTION_PATTERN, (_match, name: string) => `@${name}`);
}

/** Render-friendly token stream: alternating text + mention chunks. */
export type RenderToken =
  | { kind: "text"; text: string }
  | { kind: "mention"; name: string; userId: string };

export function tokenizeBody(body: string): RenderToken[] {
  const tokens: RenderToken[] = [];
  const mentions = parseMentions(body);
  let cursor = 0;
  for (const mention of mentions) {
    if (mention.start > cursor) {
      tokens.push({ kind: "text", text: body.slice(cursor, mention.start) });
    }
    tokens.push({ kind: "mention", name: mention.name, userId: mention.userId });
    cursor = mention.end;
  }
  if (cursor < body.length) {
    tokens.push({ kind: "text", text: body.slice(cursor) });
  }
  return tokens;
}

/**
 * Build a body with a mention chip inserted at `position`. Returns the new
 * body + the cursor offset to land at. Used by the composer when the user
 * picks a teammate from the @ popover.
 */
export function insertMention(
  body: string,
  position: number,
  triggerLength: number,
  user: { id: string; name: string },
): { body: string; cursor: number } {
  // The trigger is the "@" plus whatever has been typed since (the query).
  // It's RIGHT BEFORE the caret. Replace it with the encoded mention + a
  // trailing space so the user can keep typing without a manual space.
  const before = body.slice(0, position - triggerLength);
  const after = body.slice(position);
  const chip = `@[${user.name}](${user.id})`;
  const nextBody = `${before}${chip} ${after}`;
  const nextCursor = before.length + chip.length + 1;
  return { body: nextBody, cursor: nextCursor };
}

/**
 * Extract the active @-trigger from a body given a caret position. Returns
 * null when the caret isn't immediately after a `@<query>` sequence (no
 * whitespace allowed inside the trigger). Used to drive the popover.
 */
export interface MentionTrigger {
  /** Substring after the @, lowercased. May be empty (`@` with nothing yet). */
  query: string;
  /** Length of the trigger including the @ — handy for `insertMention`. */
  length: number;
}

export function detectActiveTrigger(body: string, caret: number): MentionTrigger | null {
  // Walk backwards from the caret looking for the @ that started this trigger.
  // Stop on any whitespace, mention chip close `)`, or message start.
  for (let i = caret - 1; i >= 0; i--) {
    const ch = body[i];
    if (ch === "@") {
      // Validate the @ is at message start or preceded by whitespace —
      // otherwise an email address like alice@example.com would falsely
      // trigger the popover on every keystroke.
      const prev = i > 0 ? body[i - 1] : null;
      if (prev !== null && prev !== " " && prev !== "\n" && prev !== "\t") {
        return null;
      }
      const query = body.slice(i + 1, caret).toLowerCase();
      // Don't trigger after a real mention closer — the caret is past `)`.
      if (query.includes(")") || query.includes("(") || query.includes("[")) {
        return null;
      }
      return { query, length: caret - i };
    }
    if (ch === " " || ch === "\n" || ch === "\t") return null;
  }
  return null;
}
