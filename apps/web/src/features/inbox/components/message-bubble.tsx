"use client";

import { memo, type ReactNode } from "react";
import { motion } from "framer-motion";
import { Ban, Check, Megaphone, Paperclip, User, X } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { avatarGradient } from "@ccp/shared/utils/avatar-color";
import { cn, initials } from "@ccp/shared/utils";
import type { Channel, Message, MessageAttribution } from "@ccp/shared/types";
import { CHANNEL_CAPABILITIES } from "@ccp/shared/providers/capabilities";
import { apiFetch } from "@/lib/api/client-fetch";
import { highlightQuery } from "./message-search";

/**
 * Locally clear a stuck CUSTOMER reaction. Instagram never sends a reaction-
 * removal webhook, so a customer who removes their reaction leaves it stuck in
 * our inbox — this lets the agent dismiss it. The server clears our stored value
 * and fans out `message.reaction_changed`, which the live reducer applies (so it
 * disappears here and for every other agent). No optimistic dispatch needed —
 * the fanout round-trips in ~100ms and keeps a single source of truth.
 */
async function dismissCustomerReaction(messageId: string): Promise<void> {
  try {
    await apiFetch("/api/messages/reaction/dismiss", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId }),
    });
  } catch {
    // Best-effort — a failed dismiss just leaves the pill; the agent can retry.
  }
}

/**
 * "From your ad" chip on the first inbound of an ad-sourced conversation
 * (Click-to-WhatsApp / Click-to-Messenger `referral`). Shows the campaign
 * headline and links to the ad, so an agent instantly knows the customer came
 * from a campaign. Sits at the top of the bubble, above the message content.
 */
// Meta social reactions can arrive as a TYPE NAME ("like" / "love" / "other"
// for a custom or sticker reaction) instead of an emoji glyph. Ingest now maps
// them, but rows stored before that fix still hold the raw word — so normalize
// at render too: a real glyph (non-ASCII) shows as-is; an ASCII type-name maps
// to its emoji (default ❤️) so the pill is never the literal word "other".
const REACTION_TYPE_EMOJI: Record<string, string> = {
  like: "👍",
  love: "❤️",
  care: "🥰",
  haha: "😆",
  laugh: "😆",
  smile: "😆",
  wow: "😮",
  sad: "😢",
  angry: "😠",
};
/**
 * Force EMOJI presentation on a single-codepoint symbol that defaults to TEXT.
 * Meta sends the heart reaction as the bare base char `❤` (U+2764) WITHOUT the
 * variation selector U+FE0F, so browsers render the black text-style heart
 * instead of the red emoji. Appending U+FE0F fixes it. Only touch a lone BMP
 * symbol with no existing selector — an already-composed emoji (`❤️`, a ZWJ
 * sequence) is length ≥ 2 and left alone; astral emoji (👍, cp > 0xFFFF) are
 * emoji-default and need nothing. Appending the selector to a symbol that is
 * already emoji-default is harmless (it just reaffirms emoji presentation).
 */
function withEmojiPresentation(glyph: string): string {
  const cps = [...glyph];
  if (cps.length !== 1) return glyph;
  const cp = cps[0]!.codePointAt(0) ?? 0;
  return cp >= 0x2000 && cp <= 0xffff ? cps[0] + "\uFE0F" : glyph;
}

function reactionGlyph(raw: string): string {
  // A real emoji glyph has a non-ASCII code point; a Meta type-name ("other")
  // is pure ASCII → map it to an emoji so the pill is never a literal word.
  for (const ch of raw) {
    if ((ch.codePointAt(0) ?? 0) > 0x7f) return withEmojiPresentation(raw);
  }
  return REACTION_TYPE_EMOJI[raw.trim().toLowerCase()] ?? "❤️";
}

function AdAttributionChip({ attribution }: { attribution: MessageAttribution }) {
  const label =
    attribution.source === "post"
      ? "From your post"
      : attribution.source === "ref"
        ? "From a link"
        : "From your ad";
  const title = attribution.headline?.trim() || attribution.body?.trim() || "";
  const inner = (
    <span className="flex items-center gap-1.5 rounded-t-[inherit] bg-primary/10 px-2.5 py-1 text-2xs font-medium text-primary">
      <Megaphone className="size-3 shrink-0" />
      <span className="truncate">
        {label}
        {title ? <span className="font-normal opacity-80"> · {title}</span> : null}
      </span>
    </span>
  );
  return attribution.sourceUrl ? (
    <a href={attribution.sourceUrl} target="_blank" rel="noopener noreferrer" className="block hover:underline">
      {inner}
    </a>
  ) : (
    inner
  );
}

/**
 * "via <app>" label for a message the business sent from Meta's own native app
 * (WhatsApp Business App / Messenger / Instagram inbox) rather than through us —
 * `origin === "business_app"`. Channel-aware so a Messenger echo doesn't read
 * "via WhatsApp app".
 */
function viaAppLabel(channel: Channel): string {
  switch (channel) {
    case "messenger":
      return "Messenger app";
    case "instagram":
      return "Instagram app";
    default:
      return "WhatsApp app";
  }
}

import { BubbleActions, FailedRecovery } from "./message-bubble/bubble-actions";
import { BubbleMeta, SenderChip } from "./message-bubble/bubble-meta";
import { MediaBlock, StickerImage } from "./message-bubble/media-blocks";
import { QuotedReply } from "./message-bubble/quoted-reply";
import { StructuredBlock } from "./message-bubble/structured-block";

/**
 * One reaction pill: a small avatar (WHO reacted) + the emoji. The avatar is the
 * whole point — in a shared inbox a bare emoji can't say whether the customer or
 * your team reacted, so the customer's initial-gradient chip and our tinted
 * "team" chip make it unmistakable at a glance. `onDismiss` (Instagram customer
 * pill only) turns it into a click-to-clear button, since IG never sends a
 * reaction-removal webhook.
 */
function ReactionPill({
  glyph,
  avatar,
  tone,
  who,
  onDismiss,
}: {
  glyph: string;
  avatar: ReactNode;
  tone: "neutral" | "accent";
  who: string;
  onDismiss?: () => void;
}) {
  const base = cn(
    "inline-flex items-center gap-1 rounded-full border py-0.5 pl-0.5 pr-2 shadow-sm",
    tone === "accent" ? "border-primary/30 bg-primary/10" : "border-border bg-card",
  );
  const emoji = reactionGlyph(glyph);
  if (onDismiss) {
    return (
      <button
        type="button"
        onClick={onDismiss}
        className={cn(base, "group/rx cursor-pointer transition-colors hover:border-destructive/50")}
        aria-label={`${who} reacted ${emoji} — click to dismiss (Instagram doesn't notify us when a customer removes a reaction)`}
        title="Instagram doesn't tell us when a customer removes their reaction — click to clear it"
      >
        {avatar}
        <span className="text-sm leading-none group-hover/rx:hidden">{emoji}</span>
        <X className="hidden size-3 text-destructive group-hover/rx:block" />
      </button>
    );
  }
  return (
    <span className={base} aria-label={`${who} reacted ${emoji}`} title={`${who} reacted ${emoji}`}>
      {avatar}
      <span className="text-sm leading-none">{emoji}</span>
    </span>
  );
}

/**
 * Reaction row tucked over the bubble's bottom edge — up to two pills (the
 * customer's `reaction` and our `agentReaction`), each avatar-tagged so who-is-
 * who is obvious. Both are independent fields, so both can show at once and
 * neither clobbers the other; renders for any message type / either direction.
 */
function MessageReactions({
  message,
  isOut,
  contactName,
  contactSeed,
}: {
  message: Message;
  isOut: boolean;
  contactName: string;
  contactSeed: string;
}) {
  if (message.deletedAt || (!message.reaction && !message.agentReaction)) return null;
  const customerAvatar = (
    <span
      className="grid size-[18px] shrink-0 place-items-center rounded-full text-[9px] font-semibold text-white"
      style={{ backgroundImage: avatarGradient(contactSeed) }}
    >
      {initials(contactName)}
    </span>
  );
  const agentAvatar = (
    <span className="grid size-[18px] shrink-0 place-items-center rounded-full bg-primary text-primary-foreground">
      <User className="size-2.5" />
    </span>
  );
  return (
    <div className={cn("relative z-10 -mt-2 flex gap-1", isOut ? "mr-1 justify-end" : "ml-1")}>
      {message.reaction && (
        <ReactionPill
          glyph={message.reaction}
          avatar={customerAvatar}
          tone="neutral"
          who={contactName}
          onDismiss={
            message.channel === "instagram"
              ? () => dismissCustomerReaction(message.id)
              : undefined
          }
        />
      )}
      {message.agentReaction && (
        <ReactionPill glyph={message.agentReaction} avatar={agentAvatar} tone="accent" who="You" />
      )}
    </div>
  );
}

interface MessageBubbleProps {
  message: Message;
  /**
   * Primitive sender name (null on inbound, null when the authoring user has
   * been hard-deleted). Passing the User object directly forced React.memo
   * to re-render every bubble whenever the team-members Map identity changed
   * (e.g. a teammate's presence flip). Primitive prop = stable shallow-equal.
   */
  senderName: string | null;
  /** Sender avatar URL. Same primitive-prop discipline as senderName. */
  senderAvatarUrl?: string | null;
  contactName: string;
  /** Stable id to derive a consistent gradient color for the contact. */
  contactSeed: string;
  /** Stash this message as the active reply target in the composer. */
  onReply?: (message: Message) => void;
  /** Scroll to the quoted original (no-op when the original is unknown). */
  onJumpToOriginal?: (originalId: string) => void;
  /** Queue this message for forwarding (opens the contact picker). */
  onForward?: (message: Message) => void;
  /** Enter multi-select mode with this message pre-checked. */
  onStartSelect?: (message: Message) => void;
  /** Drop a failed optimistic bubble from the thread. */
  onDismissFailed?: (message: Message) => void;
  /** Drop the failed bubble + put its body back in the composer to retry. */
  onRetryFailed?: (message: Message) => void;
  // ----- multi-select mode (driven by the thread) -----
  selecting?: boolean;
  selected?: boolean;
  onToggleSelect?: (messageId: string) => void;
  // ----- search highlighting (driven by the thread) -----
  /** Active query — every occurrence inside the body gets a yellow `<mark>`.
   *  Empty/undefined disables highlighting. */
  searchQuery?: string;
  /** True when this bubble is the currently-selected search match. Renders
   *  a persistent yellow ring around the bubble so the user can find it
   *  visually after scrollIntoView lands. */
  isActiveSearchMatch?: boolean;
  // ----- consecutive-message grouping (driven by the thread) -----
  /**
   * Last bubble of a same-sender group. The TAIL carries the shared chrome:
   * the inbound avatar (bottom-aligned to the group, WhatsApp-style) and the
   * meta row (timestamp / sender / ticks). Earlier bubbles in the group render
   * an equal-width avatar spacer and no meta, so a burst reads as one cluster.
   * Defaults to true → a lone/ungrouped message looks exactly as before.
   */
  showAvatar?: boolean;
  /** See `showAvatar`. When false the meta row is omitted (a non-tail bubble in
   *  a group). Pending/failed rows always pass true so their status never hides. */
  showMeta?: boolean;
  /**
   * Last bubble of a same-sender group. Only the TAIL gets the flat "tail"
   * corner (`rounded-br-xs` / `rounded-bl-xs`); earlier continuation bubbles
   * keep all four corners fully rounded so a burst reads as one stacked unit
   * instead of N independently-tailed bubbles. Defaults to true → a lone /
   * ungrouped message keeps the tail exactly as before.
   */
  isTail?: boolean;
  /** First bubble of a same-sender OUTBOUND group. When true (and there's a
   *  senderName), a small "which teammate" chip renders ABOVE the bubble —
   *  attribution at the head of a burst, not buried under its last bubble. */
  showSenderHeader?: boolean;
  /** Fade+scale the bubble in on mount — ONLY for genuinely-new live messages
   *  (TimelineRows gates it; false on initial load / load-older / refetch).
   *  Transform + opacity only, so it never perturbs the column-reverse scroll. */
  animateIn?: boolean;
}

/**
 * One row in the message timeline.
 *
 * Normal mode: a chat bubble with hover actions (quick reply + a ⋯ menu with
 * Forward / Select messages).
 *
 * Selection mode: the whole row becomes a checkbox toggle; the bubble is
 * rendered read-only. Pending/failed rows can't be forwarded (no real wamid
 * yet) so they show disabled and aren't selectable.
 *
 * Wrapped in `React.memo` at the bottom of this file. Every `message:new`
 * socket event triggers a parent re-render where the messages array gets a
 * new identity but the individual row objects don't (the touched row is the
 * only one with a new ref). Default shallow comparison + useCallback-stable
 * action handlers + primitive flags means React skips re-rendering ~all
 * rows except the one that actually changed. Without memo, every inbound /
 * status update / selection toggle / search keystroke re-rendered every
 * visible bubble — the dominant perf hit on busy threads.
 */
function MessageBubbleImpl(props: MessageBubbleProps) {
  const { message, selecting, selected, onToggleSelect } = props;

  // Failed = optimistic client failure (`failed`) OR Meta async-rejection
  // (`status === "failed"`). Both must block selection (a never-delivered row
  // isn't a normal message). See BubbleContent for the matching render gates.
  const isFailed = message.failed || message.status === "failed";

  if (selecting) {
    const selectable = !message.pending && !isFailed;
    const toggle = () => {
      if (selectable) onToggleSelect?.(message.id);
    };
    return (
      <div
        role={selectable ? "button" : undefined}
        aria-pressed={selectable ? Boolean(selected) : undefined}
        aria-disabled={selectable ? undefined : true}
        tabIndex={selectable ? 0 : -1}
        onClick={toggle}
        onKeyDown={(e) => {
          if (selectable && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            toggle();
          }
        }}
        className={cn(
          "flex w-full items-center gap-3 rounded-xl px-2 py-1 transition-colors",
          selectable
            ? "cursor-pointer hover:bg-accent/40"
            : "cursor-not-allowed opacity-50",
          selected && "bg-primary/10 ring-1 ring-primary/30",
        )}
      >
        <SelectCheckbox checked={Boolean(selected)} disabled={!selectable} />
        {/* Read-only while selecting — swallow clicks/hover on the bubble. */}
        <div className="pointer-events-none min-w-0 flex-1">
          <BubbleContent {...props} />
        </div>
      </div>
    );
  }

  return <BubbleContent {...props} />;
}

function BubbleContent({
  message,
  senderName,
  senderAvatarUrl,
  contactName,
  contactSeed,
  onReply,
  onJumpToOriginal,
  onForward,
  onStartSelect,
  onDismissFailed,
  onRetryFailed,
  searchQuery,
  isActiveSearchMatch,
  showAvatar = true,
  showMeta = true,
  isTail = true,
  showSenderHeader = false,
  animateIn = false,
}: MessageBubbleProps) {
  const isOut = message.direction === "out";
  // Failed = optimistic client-side failure (`failed`) OR an authoritative Meta
  // async-rejection (`status === "failed"`). Both drive the red ring, the
  // Retry/Dismiss row, and the not-a-normal-send gates below — see the matching
  // derivation in MessageBubbleImpl's selection branch.
  const isFailed = message.failed || message.status === "failed";
  // Attribution chip at the head of an outbound burst (shared-inbox: "which
  // teammate sent this"). Outbound + group-head. When we know the teammate we
  // show their chip; when the message was sent from the WhatsApp Business App on
  // the owner's phone (Coexistence — no authoring agent, so senderName is null),
  // we mark it "via WhatsApp app" so a phone reply is distinguishable from an
  // agent send and from a silent system/automation send.
  const senderHeader =
    showSenderHeader && message.direction === "out" ? (
      senderName ? (
        <span className="px-1 pb-0.5 text-2xs font-medium text-muted-foreground">
          <SenderChip name={senderName} avatarUrl={senderAvatarUrl ?? null} />
        </span>
      ) : message.origin === "business_app" ? (
        <span className="px-1 pb-0.5 text-2xs font-medium text-muted-foreground">
          via {viaAppLabel(message.channel)}
        </span>
      ) : null
    ) : null;
  const media = message.media;
  const reply = message.replyTo ?? null;
  // Don't offer Reply/Forward/Select on optimistic rows — the wamid isn't real
  // yet, so Meta would reject `context.message_id`, and there's nothing to
  // forward until the send lands.
  const live = !message.pending && !isFailed;
  const canReply = Boolean(onReply) && live;
  const canForward = Boolean(onForward) && live;
  const canSelect = Boolean(onStartSelect) && live;
  // React to ANY real message — inbound OR outbound (WhatsApp lets you react to
  // your own sends too), and every content type (text, media, location, …). The
  // only gates: it's a real Meta message (has an externalId), the channel
  // supports outbound reactions, and it isn't deleted. Our reaction is stored
  // separately (agentReaction) so it never collides with the customer's.
  const canReact =
    Boolean(message.externalId) &&
    !message.deletedAt &&
    Boolean(CHANNEL_CAPABILITIES[message.channel]?.sendReaction);

  // Stickers stand alone — no bubble chrome, just the image. Rendered
  // outside the standard bubble path because the visual treatment differs.
  if (media?.kind === "sticker") {
    return (
      <div className={cn("flex w-full gap-2", isOut ? "justify-end" : "justify-start")}>
        {!isOut && (
          <InboundAvatarSlot
            show={showAvatar}
            contactName={contactName}
            contactSeed={contactSeed}
          />
        )}
        <div className={cn("flex flex-col gap-0.5", isOut ? "items-end" : "items-start")}>
          {senderHeader}
          {message.mediaPending ? (
            // Don't load /api/media/<id> while the binary is still downloading —
            // it 404s and StickerImage latches "unavailable" for the session
            // (the URL doesn't change when the binary lands, so the latch never
            // clears). Show the calm 128px slot until media_ready flips this.
            <div className="size-32 rounded-md bg-muted" />
          ) : (
            <StickerImage url={media.url} isOut={isOut} />
          )}
          {showMeta && <BubbleMeta message={message} isOut={isOut} />}
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "group flex w-full gap-2",
        isOut ? "justify-end" : "justify-start",
      )}
    >
      {!isOut && (
        <InboundAvatarSlot
          show={showAvatar}
          contactName={contactName}
          contactSeed={contactSeed}
        />
      )}

      {/* Reply action sits next to the bubble; visible only on hover so it
          doesn't clutter the timeline. Order swaps so it's always on the
          opposite side of the avatar. */}
      {isOut && (
        <BubbleActions
          message={message}
          conversationId={message.conversationId}
          canReply={canReply}
          canForward={canForward}
          canSelect={canSelect}
          canReact={canReact}
          onReply={onReply}
          onForward={onForward}
          onStartSelect={onStartSelect}
        />
      )}

      <motion.div
        className={cn(
          // Cap reading width on large displays so a long message doesn't run to
          // ~60+ chars/line. Char-based cap on the BUBBLE (not the thread
          // container, which stays max-w-6xl to keep list/composer edges aligned).
          "flex max-w-[70%] flex-col gap-0.5 lg:max-w-[34rem] xl:max-w-[40rem]",
          isOut ? "items-end" : "items-start",
        )}
        // Entrance for genuinely-new live messages. Transform + opacity ONLY
        // (no height/margin), so the column-reverse stick-to-bottom
        // ResizeObserver never sees a layout change — the scroll stays pinned.
        // initial={false} renders straight at the final state with no animation
        // (initial load, load-older, reconnect-refetch). Scales up from the
        // bubble's bottom corner so it grows into place.
        initial={animateIn ? { opacity: 0, scale: 0.96 } : false}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
        style={{ transformOrigin: isOut ? "right bottom" : "left bottom" }}
      >
        {senderHeader}
        <div
          className={cn(
            "overflow-hidden rounded-2xl text-sm leading-snug shadow-xs ring-1 transition-[box-shadow,background-color]",
            // Reduce horizontal padding when the leading element is a media
            // block or a structured card (location map / contact / order) —
            // they look better edge-to-edge inside the bubble, WhatsApp-style,
            // instead of floating in bubble-colored padding.
            media || reply || message.structured ? "p-1" : "px-3.5 py-2",
            // Failed bubble: red ring so the eye snaps to it. Pending no
            // longer dims — the clock icon in the meta row conveys "in
            // flight" without making the bubble look unfinished, so a fast
            // send feels instant rather than slightly-loading.
            isFailed && "opacity-80 ring-destructive/60",
            isOut
              ? "bg-outbound-bg text-outbound-fg ring-transparent"
              : "bg-inbound-bg text-inbound-fg ring-border/50",
            // Flat tail corner ONLY on the group's last bubble; continuation
            // bubbles keep all four corners rounded so a stack reads as one
            // unit. (`rounded-2xl` above already rounds every corner.)
            isTail && (isOut ? "rounded-br-xs" : "rounded-bl-xs"),
            // Active search match — a soft primary ring that stays for as
            // long as the bubble is the selected match. The primary hue is
            // instantly readable as a selection/focus signal (matching the
            // reply-jump ring) so the active hit pops out of the thread
            // without darkening the bubble's own color.
            isActiveSearchMatch &&
              "ring-2 ring-primary/50 ring-offset-2 ring-offset-background",
          )}
        >
          {message.attribution && !message.deletedAt && (
            <AdAttributionChip attribution={message.attribution} />
          )}
          {message.deletedAt ? (
            // Customer unsent this message (WhatsApp revoke / Messenger·IG
            // unsend). The row is kept for the record; the content is replaced
            // by a tombstone — mirrors WhatsApp/Respond.io behavior.
            <p className="flex items-center gap-1.5 px-2.5 py-1.5 text-sm italic text-muted-foreground">
              <Ban className="size-3.5 shrink-0" />
              This message was deleted
            </p>
          ) : message.structured ? (
            // Location pin / contact card — a dedicated bubble replacing the
            // plain text placeholder (the placeholder body is still stored for
            // search / list preview, just not rendered here). A STORY reply,
            // though, carries the customer's actual reply TEXT as the body, so
            // render it under the card — hiding it would drop the message.
            <>
              <StructuredBlock structured={message.structured} isOut={isOut} />
              {message.structured.kind === "story" && message.body && (
                <p
                  dir="auto"
                  className="whitespace-pre-wrap wrap-break-word px-2.5 pb-1.5 pt-2"
                >
                  {searchQuery && searchQuery.trim().length > 0
                    ? highlightQuery(message.body, searchQuery)
                    : message.body}
                </p>
              )}
            </>
          ) : (
            <>
              {reply && (
                <QuotedReply
                  reply={reply}
                  isOut={isOut}
                  contactName={contactName}
                  searchQuery={searchQuery}
                  onClick={
                    onJumpToOriginal ? () => onJumpToOriginal(reply.id) : undefined
                  }
                />
              )}
              {media && (
                <MediaBlock
                  media={media}
                  message={message}
                  isOut={isOut}
                  pending={message.mediaPending}
                />
              )}
              {message.body && (
                <p
                  // dir="auto" derives base direction from the first strong
                  // character so Arabic/Hebrew messages right-align with correct
                  // punctuation placement (WhatsApp Web behavior). Latin stays LTR.
                  dir="auto"
                  className={cn(
                    "whitespace-pre-wrap wrap-break-word",
                    media || reply ? "px-2.5 pb-1.5 pt-2" : "",
                  )}
                >
                  {searchQuery && searchQuery.trim().length > 0
                    ? highlightQuery(message.body, searchQuery)
                    : message.body}
                  {message.editedAt && (
                    <span className="ml-1 align-baseline text-2xs italic text-muted-foreground/80">
                      (edited)
                    </span>
                  )}
                </p>
              )}
              {/* Failed inbound media. A photo/voice/doc whose download from Meta
                  failed after retries has its media columns stripped and (when
                  there was no caption) an EMPTY body — which rendered as a blank
                  bubble. The Meta parser never creates an empty-body, no-media
                  INBOUND any other way (text/interactive/reaction without content
                  are skipped), so this is unambiguously "an attachment we couldn't
                  download". Client-only + derived, so it's consistent live AND on
                  reload with no schema/event change. */}
              {!isOut && !media && !message.mediaPending && !message.body && (
                <p className="flex items-center gap-1.5 px-2.5 py-1.5 text-sm italic text-muted-foreground">
                  <Paperclip className="size-3.5 shrink-0" />
                  Attachment unavailable
                </p>
              )}
            </>
          )}
        </div>

        <MessageReactions
          message={message}
          isOut={isOut}
          contactName={contactName}
          contactSeed={contactSeed}
        />

        {showMeta && <BubbleMeta message={message} isOut={isOut} />}
        {isFailed && (
          <FailedRecovery
            // Both text and media retries are supported. The composer caches
            // the File for each in-flight media send keyed by clientTempId,
            // so Retry pops it back into the attachment preview without
            // forcing a re-pick from disk. See pendingFilesRef in reply-box.
            canRetry={Boolean(onRetryFailed)}
            onRetry={onRetryFailed ? () => onRetryFailed(message) : undefined}
            // Dismiss only drops a still-optimistic bubble (it removes by
            // clientTempId). A server-rejected message is a real persisted row
            // with no clientTempId, so removeOptimistic would no-op — hide
            // Dismiss there and offer Retry (resend) only.
            onDismiss={
              onDismissFailed && message.clientTempId
                ? () => onDismissFailed(message)
                : undefined
            }
          />
        )}
      </motion.div>

      {!isOut && (
        <BubbleActions
          message={message}
          conversationId={message.conversationId}
          canReply={canReply}
          canForward={canForward}
          canSelect={canSelect}
          canReact={canReact}
          onReply={onReply}
          onForward={onForward}
          onStartSelect={onStartSelect}
        />
      )}
    </div>
  );
}

/**
 * Inbound avatar column. Renders the contact avatar on the group TAIL
 * (`show`), or an equal-width spacer on earlier bubbles of a consecutive
 * group, so a same-sender burst keeps its left edge aligned under a single
 * bottom-anchored avatar (WhatsApp-style) instead of repeating it per bubble.
 */
function InboundAvatarSlot({
  show,
  contactName,
  contactSeed,
}: {
  show: boolean;
  contactName: string;
  contactSeed: string;
}) {
  if (!show) return <div className="size-7 shrink-0" aria-hidden />;
  return (
    <Avatar className="size-7 shrink-0 self-end">
      <AvatarFallback
        className="text-3xs text-white"
        style={{ backgroundImage: avatarGradient(contactSeed) }}
      >
        {initials(contactName)}
      </AvatarFallback>
    </Avatar>
  );
}

function SelectCheckbox({
  checked,
  disabled,
}: {
  checked: boolean;
  disabled?: boolean;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors",
        disabled
          ? "border-muted-foreground/30"
          : checked
            ? "border-primary bg-primary text-primary-foreground"
            : "border-muted-foreground/50",
      )}
    >
      {checked && <Check className="size-3" />}
    </span>
  );
}

export const MessageBubble = memo(MessageBubbleImpl);
