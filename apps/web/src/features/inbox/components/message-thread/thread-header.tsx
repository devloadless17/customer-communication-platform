"use client";

import { memo, useEffect, useState } from "react";
import { ChevronLeft, Info, Phone, Search as SearchIcon } from "lucide-react";

import { AiStateControl } from "../ai/ai-state-control";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { useCallApi } from "@/features/calls/call-provider";
import { AccountLabel } from "@/features/channels/components/account-label";
import { ContactStagePicker } from "@/features/contacts/components/contact-stage-picker";
import { avatarGradient } from "@ccp/shared/utils/avatar-color";
import { CHANNEL_CAPABILITIES } from "@ccp/shared/providers/capabilities";
import { formatPhone, initials } from "@ccp/shared/utils";
import type { Channel, ContactStage, ConversationStatus, User } from "@ccp/shared/types";

/** Display name for the call button's channel label. */
function callChannelName(channel: Channel | undefined): string {
  switch (channel) {
    case "messenger":
      return "Messenger";
    case "instagram":
      return "Instagram";
    default:
      return "WhatsApp";
  }
}

import { AssignmentDropdown } from "./assignment-dropdown";
import { ConversationMenu } from "./conversation-menu";
import { StatusDropdown } from "./status-dropdown";

/**
 * Tiny "X is also viewing this" pill. Shown to the right of the contact
 * name when one or more OTHER teammates have this conversation open.
 * Empty list (the common case) renders nothing.
 *
 * Up to 3 avatars; the rest collapse to `+N`. Tooltip on hover lists every
 * viewer by name. Stable identity per-userId so the avatar row doesn't
 * reshuffle on every membership change.
 */
/**
 * Live presence of a WEBSITE-WIDGET visitor, so an agent knows whether the person
 * is still on the page instead of waiting on a dead thread.
 *
 *   online  → the visitor's browser is connected right now.
 *   away    → their socket dropped (tab hidden, navigated, closed). Shows how long
 *             ago, ticking, because "left just now" and "left 20m ago" mean very
 *             different things for whether to keep the thread open.
 *   (nothing) until the first frame — never guess.
 *
 * Ephemeral: from the socket, not persisted. A refresh re-derives it on reconnect.
 */
function VisitorPresenceChip({ present, leftAt }: { present?: boolean | null; leftAt?: number | null }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (present !== false) return;
    const t = setInterval(() => tick((n) => n + 1), 30_000); // refresh "Xm ago"
    return () => clearInterval(t);
  }, [present]);

  if (present == null) return null; // unknown — no frame yet
  if (present) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-2xs font-medium text-emerald-600 dark:text-emerald-400">
        <span className="size-1.5 rounded-full bg-emerald-500" />
        Online
      </span>
    );
  }
  const ago = leftAt ? Math.max(0, Math.round((Date.now() - leftAt) / 60000)) : 0;
  const label = !leftAt ? "Away" : ago < 1 ? "Left just now" : `Left ${ago}m ago`;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-2xs font-medium text-muted-foreground">
      <span className="size-1.5 rounded-full bg-muted-foreground/50" />
      {label}
    </span>
  );
}

function ConversationViewersPill({ viewers }: { viewers: User[] }) {
  if (viewers.length === 0) return null;
  const shown = viewers.slice(0, 3);
  const extra = viewers.length - shown.length;
  const title =
    viewers.length === 1
      ? `${viewers[0]!.name} is also viewing this chat`
      : `${viewers.map((v) => v.name).join(", ")} are also viewing this chat`;
  return (
    <div
      className="ml-2 flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-warning-border bg-warning-bg px-2.5 py-1 text-2xs text-warning-fg"
      title={title}
      aria-label={title}
    >
      <div className="flex shrink-0 -space-x-2">
        {shown.map((u) => (
          <Avatar
            key={u.id}
            className="size-4 ring-1 ring-warning-bg"
          >
            <AvatarFallback
              className="text-4xs text-white"
              style={{ backgroundImage: avatarGradient(u.id) }}
            >
              {initials(u.name)}
            </AvatarFallback>
          </Avatar>
        ))}
      </div>
      {extra > 0 ? (
        <span className="font-medium">+{extra} viewing</span>
      ) : (
        <span className="font-medium">also viewing</span>
      )}
    </div>
  );
}

// Memoized — the parent MessageThread re-renders on the 60s `now` tick, every
// teammate typing frame, and every in-thread search keystroke; the header's
// props are all stable across those, so it should bail. (Same rationale as the
// memoized TimelineRows extraction.)
function ThreadHeaderImpl({
  workspaceId,
  conversationId,
  contactId,
  contactName,
  contactAvatarUrl,
  contactBlockedAt,
  phone,
  status,
  assignedUserId,
  assignedUserName,
  assignedUserAvatarUrl,
  teamMembers,
  currentUserName,
  otherViewers,
  onAlert,
  onOpenSearch,
  stageCatalog,
  currentStageId,
  onStageChange,
  canManageStages,
  canDeleteConversations,
  canMakeCalls,
  canAssignOthers,
  currentUserId,
  callChannel,
  onInitiateCall,
  onMobileBack,
  onOpenContactDetails,
  channel,
  channelConnectionId,
  visitorPresent,
  visitorLeftAt,
}: {
  workspaceId: string;
  conversationId: string;
  contactId: string;
  contactName: string;
  contactAvatarUrl: string | null;
  /** Provider-level block state — drives the menu's Block/Unblock label. */
  contactBlockedAt?: string | null;
  phone: string | null;
  status: ConversationStatus;
  /** AI Autopilot state for the header toggle (per-conversation). */
  /** Team-level opt-in — when false the AI toggle is hidden entirely. */
  assignedUserId: string | null;
  assignedUserName: string | null;
  assignedUserAvatarUrl?: string | null;
  teamMembers: User[];
  /** Current agent's display name — actor on optimistic activity pills. */
  currentUserName: string;
  /**
   * Other teammates currently viewing this conversation. Empty array = no
   * pill. Driven by `useConversationViewers` in the parent — already
   * filtered to exclude the current user.
   */
  otherViewers: User[];
  /** Surface server errors via the app's modal alert. */
  onAlert: (title: string, description?: string) => Promise<void>;
  /** Open the in-conversation search overlay. */
  onOpenSearch: () => void;
  stageCatalog: ContactStage[];
  currentStageId: string | null;
  onStageChange: (stageId: string) => Promise<void>;
  canManageStages: boolean;
  /** Whether the current user can delete this conversation. Hides the
   *  delete action inside ConversationMenu when false. */
  canDeleteConversations: boolean;
  /**
   * Whether to surface the Phone button. The parent has already filtered
   * for: (a) capability `calls:make`, (b) the channel's `calling` capability
   * (WhatsApp + Messenger), and (c) contact country NOT on the BIC blocklist.
   * False = hide button.
   */
  canMakeCalls: boolean;
  canAssignOthers: boolean;
  currentUserId: string;
  /** Channel of this thread — drives the call button's label ("Call on
   *  WhatsApp" / "Call on Messenger"). Defaults to WhatsApp copy if absent. */
  callChannel?: Channel;
  /** Click handler — kicks off the outbound-call flow + handles 4xx UI. */
  onInitiateCall: () => void | Promise<void>;
  /** Mobile back-to-list affordance. Only rendered when set + below md. */
  onMobileBack?: () => void;
  /** Opens the contact details Sheet. Only rendered when set + below lg (the
   *  desktop contact rail is hidden there, so this is the only way in). */
  onOpenContactDetails?: () => void;
  /** Channel of this conversation — presence chip is webchatwidget-only. */
  channel?: Channel;
  /** Which of the workspace's accounts (WhatsApp number / Page / IG handle)
   *  this thread is on. Shown only when the channel has more than one. */
  channelConnectionId?: string | null;
  /** Website visitor presence (null until a frame arrives). */
  visitorPresent?: boolean | null;
  visitorLeftAt?: number | null;
}) {
  // Disable the Phone button while any call is live/in-flight. The single
  // useCall instance lives in the app-wide CallProvider; `liveCall` is non-null
  // from the optimistic ringing state through teardown. This is the visible
  // affordance backing the synchronous busyRef guard in useCall.initiateOutbound.
  const { liveCall } = useCallApi();
  // AI state lifted from AiStateControl so the assignee can read "AI Agent"
  // while the assistant is active (label only — no real user is assigned).
  const [aiState, setAiState] = useState<
    "ai_active" | "human_active" | "ai_paused" | "disabled" | null
  >(null);
  // "You are replying AS this number." The single most useful place for it: an
  // agent about to type sees which of the workspace's numbers the customer is
  // talking to, without opening settings. Null unless the channel actually has
  // more than one account.
  // Provider-level blocking is a CHANNEL capability (WhatsApp Block Users API
  // today) — derived from the same map the composer reads, never hardcoded.
  const canBlockContact = !!channel && !!CHANNEL_CAPABILITIES[channel]?.blockUsers;
  return (
    <header className="@container flex h-15 shrink-0 items-center gap-2 border-b border-border px-3 md:gap-3 md:px-4">
      {onMobileBack && (
        <button
          type="button"
          onClick={onMobileBack}
          aria-label="Back to conversations"
          className="-ml-1 inline-flex size-8 pointer-coarse:size-9 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground lg:hidden"
        >
          <ChevronLeft className="size-5" />
        </button>
      )}
      <Avatar className="size-9">
        {contactAvatarUrl ? <AvatarImage src={contactAvatarUrl} alt="" /> : null}
        <AvatarFallback
          className="text-xs text-white"
          style={{ backgroundImage: avatarGradient(contactId) }}
        >
          {initials(contactName)}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h2 className="truncate text-sm font-semibold">{contactName}</h2>
          <ConversationViewersPill viewers={otherViewers} />
          {channel === "webchatwidget" && (
            <VisitorPresenceChip present={visitorPresent} leftAt={visitorLeftAt} />
          )}
        </div>
        <div className="flex items-center gap-1.5 truncate text-2xs text-muted-foreground">
          <span className="truncate font-mono tabular-nums">{formatPhone(phone)}</span>
          <AccountLabel
            channel={channel}
            accountId={channelConnectionId}
            variant="inline"
            verb="Replying from"
            showReconnect
          />
        </div>
      </div>

      {/* Stage pill — contact metadata, lower priority than the customer's
          name/phone. Container-query gated (@[740px] of HEADER width, not
          viewport) so when the thread column is narrow it hides instead of
          squeezing the name into "Ali …". Reappears once there's room. The
          740px threshold sits wide enough that the pill never competes with the
          assignment/status triggers for space on a mid-width thread. */}
      <div className="ml-2 hidden shrink-0 @[740px]:flex">
        {/* Just the clickable stage pill (opens the picker to jump to any
            stage). The prev/next stepper arrows were removed per design —
            the pill's dropdown covers the same moves. */}
        <ContactStagePicker
          stages={stageCatalog}
          currentStageId={currentStageId}
          onChange={onStageChange}
          canManage={canManageStages}
          size="sm"
        />
      </div>

      <div className="ml-auto flex items-center gap-1.5">
        <Button
          variant="ghost"
          size="icon"
          onClick={onOpenSearch}
          aria-label="Search this conversation"
          title="Search this conversation (⌘F)"
          className="size-8 pointer-coarse:size-9 text-muted-foreground hover:text-foreground"
        >
          <SearchIcon className="size-4" />
        </Button>
        {canMakeCalls && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void onInitiateCall()}
            disabled={liveCall != null}
            aria-label={`Start a ${callChannelName(callChannel)} call with this contact`}
            title={`Call on ${callChannelName(callChannel)}`}
            className="size-8 pointer-coarse:size-9 text-muted-foreground hover:text-foreground"
          >
            <Phone className="size-4" />
          </Button>
        )}
        <AiStateControl conversationId={conversationId} onState={setAiState} />
        <AssignmentDropdown
          workspaceId={workspaceId}
          conversationId={conversationId}
          currentId={assignedUserId}
          currentName={assignedUserName}
          currentAvatarUrl={assignedUserAvatarUrl ?? null}
          currentStatus={status}
          teamMembers={teamMembers}
          currentUserName={currentUserName}
          onAlert={onAlert}
          aiActive={aiState === "ai_active"}
          canAssignOthers={canAssignOthers}
          currentUserId={currentUserId}
        />
        <StatusDropdown
          workspaceId={workspaceId}
          conversationId={conversationId}
          current={status}
          assignedUserId={assignedUserId}
          teamMembers={teamMembers}
          currentUserName={currentUserName}
          onAlert={onAlert}
        />
        {/* The legacy AI Autopilot per-conversation toggle used to render here.
            Removed with the autopilot itself: the built-in assistant is the AI
            now, and its pause / resume / take-over control is `AiStateControl`
            above. Leaving both shipped two AI switches side by side that meant
            different things — and once the autopilot settings page was gone,
            a team that had it enabled could no longer turn this one off. The
            `Conversation.aiEnabled` column and the /v1 endpoint stay for any
            org still driving an external flow through the API. */}
        {(canDeleteConversations || canBlockContact) && (
          <ConversationMenu
            conversationId={conversationId}
            contactId={contactId}
            contactName={contactName}
            contactBlockedAt={contactBlockedAt}
            canBlock={canBlockContact}
            canDelete={canDeleteConversations}
          />
        )}
        {/* Contact details — below lg the desktop right rail is hidden, so this
            is the only way to reach tags / stage / custom fields / files on a
            phone or tablet. Opens the panel in a Sheet (shell-owned). */}
        {onOpenContactDetails && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onOpenContactDetails}
            aria-label="Contact details"
            title="Contact details"
            className="size-8 pointer-coarse:size-9 text-muted-foreground hover:text-foreground lg:hidden"
          >
            <Info className="size-4" />
          </Button>
        )}
      </div>
    </header>
  );
}

export const ThreadHeader = memo(ThreadHeaderImpl);
