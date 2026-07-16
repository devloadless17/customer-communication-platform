"use client";

import { memo } from "react";
import { ChevronLeft, Info, Phone, Search as SearchIcon } from "lucide-react";

import { AiStateControl } from "../ai/ai-state-control";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { useCallApi } from "@/features/calls/call-provider";
import { ContactStagePicker } from "@/features/contacts/components/contact-stage-picker";
import { avatarGradient } from "@ccp/shared/utils/avatar-color";
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
import { AiToggle } from "./ai-toggle";
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
  teamId,
  conversationId,
  contactId,
  contactName,
  contactAvatarUrl,
  phone,
  status,
  aiEnabled,
  aiAutopilotEnabled,
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
  callChannel,
  onInitiateCall,
  onMobileBack,
  onOpenContactDetails,
}: {
  teamId: string;
  conversationId: string;
  contactId: string;
  contactName: string;
  contactAvatarUrl: string | null;
  phone: string | null;
  status: ConversationStatus;
  /** AI Autopilot state for the header toggle (per-conversation). */
  aiEnabled: boolean;
  /** Team-level opt-in — when false the AI toggle is hidden entirely. */
  aiAutopilotEnabled: boolean;
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
}) {
  // Disable the Phone button while any call is live/in-flight. The single
  // useCall instance lives in the app-wide CallProvider; `liveCall` is non-null
  // from the optimistic ringing state through teardown. This is the visible
  // affordance backing the synchronous busyRef guard in useCall.initiateOutbound.
  const { liveCall } = useCallApi();
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
        </div>
        <div className="truncate font-mono text-2xs tabular-nums text-muted-foreground">
          {formatPhone(phone)}
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
        <AiStateControl conversationId={conversationId} />
        <AssignmentDropdown
          teamId={teamId}
          conversationId={conversationId}
          currentId={assignedUserId}
          currentName={assignedUserName}
          currentAvatarUrl={assignedUserAvatarUrl ?? null}
          currentStatus={status}
          teamMembers={teamMembers}
          currentUserName={currentUserName}
          onAlert={onAlert}
        />
        <StatusDropdown
          teamId={teamId}
          conversationId={conversationId}
          current={status}
          assignedUserId={assignedUserId}
          teamMembers={teamMembers}
          currentUserName={currentUserName}
          onAlert={onAlert}
        />
        {aiAutopilotEnabled && (
          <AiToggle
            teamId={teamId}
            conversationId={conversationId}
            aiEnabled={aiEnabled}
            currentUserName={currentUserName}
            onAlert={onAlert}
          />
        )}
        {canDeleteConversations && (
          <ConversationMenu
            conversationId={conversationId}
            contactName={contactName}
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
