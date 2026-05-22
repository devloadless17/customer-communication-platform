"use client";

import {
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  type TextareaHTMLAttributes,
} from "react";

import { cn } from "@ccp/shared/utils";
import type { ContactFieldDefinition } from "@ccp/shared/types";

/**
 * Highlight `$var.contact.<field>` tokens inline with the typed text.
 *
 * Native <input>/<textarea> can't render styled children, so we use the
 * "ghost overlay" trick: a styled <div> sits on top of the field with the
 * exact same font/padding/line-height, painting the text — and tokens get
 * wrapped in a colored span. The real field keeps the caret, selection,
 * scroll, keyboard, paste — everything. Only the visible text comes from
 * the overlay; the input's own text is rendered transparent.
 *
 * Two variants share one renderer:
 *   - <TokenHighlightInput>     wraps <input type="text"> (single-line)
 *   - <TokenHighlightTextarea>  wraps <textarea>
 *
 * Both forward refs and props (so callers like the broadcast form can keep
 * a ref to splice text at the cursor) and accept a `fieldDefinitions` array
 * to gray out unknown tokens (useful as a soft "this isn't a real field"
 * hint without being aggressive).
 */

interface CommonProps {
  fieldDefinitions: ContactFieldDefinition[];
  /** When true, `$var.agent.name` / `$var.agent.email` highlight as known. */
  includeAgent?: boolean;
  /** When true, `$var.message.*` highlights as known (workflow editor). */
  includeMessage?: boolean;
  /** When true, `$var.conversation.*` highlights as known (workflow editor). */
  includeConversation?: boolean;
  /** Optional wrapper class on the outer relative container. */
  wrapperClassName?: string;
}

const MESSAGE_KEYS = [
  "body",
  "timestamp",
  "direction",
  "id",
  "external_id",
  "media_kind",
  "media_caption",
];
const CONVERSATION_KEYS = [
  "id",
  "status",
  "assigned_user_id",
  "unread_count",
  "last_message_at",
];

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

/**
 * Split text into <span> nodes — plain runs as-is, token runs in a chip-style
 * span. The regex matches both `$var.contact.<key>` and `$var.agent.<key>`;
 * we namespace-scope the known-keys set so a contact field name leaking into
 * the agent namespace (or vice versa) still renders amber/unknown.
 */
function renderTokenized(
  text: string,
  knownKeys: Set<string>,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  // Matches the same N-deep token grammar the shared resolver uses. The
  // capture group is the FULL dotted path after `$var.`; isTokenKnown
  // decides whether to render blue (known) or amber (unknown).
  const re =
    /(?<![A-Za-z0-9_])\$var\.([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)+)\b/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastIndex) {
      nodes.push(text.slice(lastIndex, m.index));
    }
    const isKnown = isTokenKnown(m[1]!, knownKeys);
    nodes.push(
      <span
        key={`tok-${i++}`}
        className={cn(
          "rounded-xs px-0.5",
          isKnown
            ? "bg-blue-500/10 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300"
            : "bg-amber-500/10 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300",
        )}
      >
        {m[0]}
      </span>,
    );
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  // Trailing newline gotcha: when the textarea content ends with "\n",
  // <pre>-wrapped content collapses the final empty line away, so the
  // overlay shows one fewer line than the textarea. Append a no-op space
  // glyph so the overlay's height matches.
  if (text.endsWith("\n")) nodes.push(" ");
  return nodes;
}

/**
 * Validate a parsed token path against the known-keys schema.
 *
 *   - legacy 2-deep paths: knownKeys lookup as before.
 *   - `trigger.<sub>.<key>`: passthrough — known iff the underlying
 *     2-deep alias is known.
 *   - `sender.<key>`: known if any contact / agent key matches.
 *   - `previousStep.<...>` and `steps.<id>.<...>`: optimistically known,
 *     since step outputs are run-time shapes the static schema can't
 *     describe. Same fail-soft default the resolver uses (empty string on
 *     a miss).
 */
function isTokenKnown(fullPath: string, knownKeys: Set<string>): boolean {
  const segments = fullPath.split(".");
  if (segments.length < 2) return false;
  const ns = segments[0]!;
  if (
    (ns === "contact" || ns === "agent" || ns === "message" || ns === "conversation") &&
    segments.length === 2
  ) {
    return knownKeys.has(`${ns}.${segments[1]!}`);
  }
  if (ns === "trigger" && segments.length === 3) {
    return knownKeys.has(`${segments[1]!}.${segments[2]!}`);
  }
  if (ns === "sender" && segments.length === 2) {
    const k = segments[1]!;
    return knownKeys.has(`contact.${k}`) || knownKeys.has(`agent.${k}`);
  }
  if (ns === "previousStep" && segments.length >= 2) return true;
  if (ns === "steps" && segments.length >= 3) return true;
  return false;
}

function useKnownKeys(
  fieldDefinitions: ContactFieldDefinition[],
  includeAgent: boolean,
  includeMessage: boolean,
  includeConversation: boolean,
): Set<string> {
  return useMemo(
    () => {
      const set = new Set<string>([
        "contact.name",
        "contact.phone",
        "contact.email",
        "contact.location",
        ...fieldDefinitions.map((d) => `contact.${d.key}`),
      ]);
      if (includeAgent) {
        set.add("agent.name");
        set.add("agent.email");
      }
      if (includeMessage) {
        for (const k of MESSAGE_KEYS) set.add(`message.${k}`);
      }
      if (includeConversation) {
        for (const k of CONVERSATION_KEYS) set.add(`conversation.${k}`);
      }
      return set;
    },
    [fieldDefinitions, includeAgent, includeMessage, includeConversation],
  );
}

// ---------------------------------------------------------------------------
// Input (single-line) variant
// ---------------------------------------------------------------------------

export type TokenHighlightInputProps = InputHTMLAttributes<HTMLInputElement> &
  CommonProps & {
    ref?: Ref<HTMLInputElement>;
  };

/**
 * Drop-in replacement for the <Input> component when the field accepts
 * `$var.contact.X` tokens. Same height + style as the shadcn <Input>, with
 * an absolutely-positioned overlay painting the tokens.
 *
 * Caveat: forms that rely on the input's text COLOR being visible (e.g.
 * a form with `type="password"`) shouldn't use this — we paint the
 * underlying text transparent.
 *
 * React 19: ref is a regular prop. `useImperativeHandle` still does the
 * external/internal ref merge — callers can focus / setSelectionRange via
 * their ref while we keep our own for scroll sync.
 */
export function TokenHighlightInput({
  className,
  wrapperClassName,
  fieldDefinitions,
  includeAgent = false,
  includeMessage = false,
  includeConversation = false,
  value,
  ref,
  ...props
}: TokenHighlightInputProps) {
  const knownKeys = useKnownKeys(
    fieldDefinitions,
    includeAgent,
    includeMessage,
    includeConversation,
  );
  const text = typeof value === "string" ? value : "";
  const innerRef = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => innerRef.current as HTMLInputElement);

  // Track horizontal scroll inside the input — for long values the text
  // shifts but the overlay would otherwise stay anchored at 0.
  const [scrollLeft, setScrollLeft] = useState(0);

  return (
    <div className={cn("relative w-full", wrapperClassName)}>
      <div
        aria-hidden="true"
        // Mirror the <Input> box exactly. `flex items-center` reproduces the
        // browser's native vertical-centering of single-line input text —
        // simpler and more robust than computing line-height + padding by
        // hand. `inset-px` accounts for the 1px border so content edges
        // align with the input's content area.
        className={cn(
          "pointer-events-none absolute inset-px flex items-center overflow-hidden whitespace-pre px-3 text-sm text-foreground",
        )}
        style={{ transform: `translateX(${-scrollLeft}px)` }}
      >
        {text.length === 0 ? (
          // Empty input — overlay holds a zero-width space so the line
          // height matches the empty native field.
          <span>&#8203;</span>
        ) : (
          renderTokenized(text, knownKeys)
        )}
      </div>
      <input
        ref={innerRef}
        type="text"
        value={value}
        onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}
        className={cn(
          "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors",
          "placeholder:text-muted-foreground",
          "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
          "disabled:cursor-not-allowed disabled:opacity-50",
          // The overlay paints the visible text; the input itself holds
          // an invisible copy so caret + selection still work natively.
          "text-transparent caret-foreground selection:bg-blue-500/30 selection:text-transparent",
          className,
        )}
        {...props}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Textarea (multi-line) variant
// ---------------------------------------------------------------------------

export type TokenHighlightTextareaProps =
  TextareaHTMLAttributes<HTMLTextAreaElement> &
    CommonProps & {
      ref?: Ref<HTMLTextAreaElement>;
    };

export function TokenHighlightTextarea({
  className,
  wrapperClassName,
  fieldDefinitions,
  includeAgent = false,
  includeMessage = false,
  includeConversation = false,
  value,
  ref,
  ...props
}: TokenHighlightTextareaProps) {
  const knownKeys = useKnownKeys(
    fieldDefinitions,
    includeAgent,
    includeMessage,
    includeConversation,
  );
  const text = typeof value === "string" ? value : "";
  const innerRef = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => innerRef.current as HTMLTextAreaElement);

  // Mirror the textarea's vertical scroll so the overlay stays aligned when
  // the field overflows its visible height.
  const [scrollTop, setScrollTop] = useState(0);

  return (
    <div className={cn("relative w-full", wrapperClassName)}>
      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-px overflow-hidden whitespace-pre-wrap wrap-break-word px-3 py-2 text-sm leading-relaxed text-foreground",
          // Match the textarea's font choice. Callers can pass `font-mono`
          // etc. via `className` and we apply it both here and on the
          // textarea below so metrics stay identical.
          className,
        )}
        style={{ transform: `translateY(${-scrollTop}px)` }}
      >
        {text.length === 0 ? <span>&#8203;</span> : renderTokenized(text, knownKeys)}
      </div>
      <textarea
        ref={innerRef}
        value={value}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        className={cn(
          // `leading-relaxed` + `wrap-break-word` MUST match the overlay div
          // above exactly. The overlay paints the visible text; the textarea
          // only holds the (transparent) caret + owns the scroll. If their
          // line-height or word-wrap differ, the painted text drifts away
          // from the caret line by line and slides out of the box. Keep them
          // identical whenever you touch either.
          "flex min-h-15 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm leading-relaxed shadow-xs transition-colors",
          "placeholder:text-muted-foreground",
          "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
          "disabled:cursor-not-allowed disabled:opacity-50",
          "resize-none wrap-break-word",
          "text-transparent caret-foreground selection:bg-blue-500/30 selection:text-transparent",
          className,
        )}
        {...props}
      />
    </div>
  );
}
