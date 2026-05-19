"use client";

import { ChevronLeft, Search as SearchIcon } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ContactStageStepper } from "@/features/contacts/components/contact-stage-picker";
import { avatarGradient } from "@ccp/shared/utils/avatar-color";
import { formatPhone, initials } from "@ccp/shared/utils";
import type { ContactStage, ConversationStatus, User } from "@ccp/shared/types";

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
      className="ml-2 flex items-center gap-1.5 rounded-full border border-amber-300/50 bg-amber-50 px-2 py-0.5 text-[11px] text-amber-900 dark:border-amber-700/40 dark:bg-amber-900/20 dark:text-amber-200"
      title={title}
      aria-label={title}
    >
      <div className="flex -space-x-1.5">
        {shown.map((u) => (
          <Avatar
            key={u.id}
            className="size-4 ring-1 ring-amber-50 dark:ring-amber-900/20"
          >
            <AvatarFallback
              className="text-[8px] text-white"
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

export function ThreadHeader({
  conversationId,
  contactId,
  contactName,
  phone,
  status,
  assignedUserId,
  assignedUserName,
  teamMembers,
  otherViewers,
  onAlert,
  onOpenSearch,
  stageCatalog,
  currentStageId,
  onStageChange,
  canManageStages,
  onMobileBack,
}: {
  conversationId: string;
  contactId: string;
  contactName: string;
  phone: string | null;
  status: ConversationStatus;
  assignedUserId: string | null;
  assignedUserName: string | null;
  teamMembers: User[];
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
  /** Mobile back-to-list affordance. Only rendered when set + below md. */
  onMobileBack?: () => void;
}) {
  return (
    <header className="flex h-15 shrink-0 items-center gap-2 border-b border-border px-3 md:gap-3 md:px-4">
      {onMobileBack && (
        <button
          type="button"
          onClick={onMobileBack}
          aria-label="Back to conversations"
          className="-ml-1 inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:hidden"
        >
          <ChevronLeft className="size-5" />
        </button>
      )}
      <Avatar className="size-9">
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
        <div className="font-mono text-[11px] text-muted-foreground">{formatPhone(phone)}</div>
      </div>

      <div className="ml-3 hidden shrink-0 md:flex">
        <ContactStageStepper
          stages={stageCatalog}
          currentStageId={currentStageId}
          onChange={onStageChange}
          canManage={canManageStages}
        />
      </div>

      <div className="ml-auto flex items-center gap-1.5">
        <Button
          variant="ghost"
          size="icon"
          onClick={onOpenSearch}
          aria-label="Search this conversation"
          title="Search this conversation (⌘F)"
          className="size-8 text-muted-foreground hover:text-foreground"
        >
          <SearchIcon className="size-4" />
        </Button>
        <AssignmentDropdown
          conversationId={conversationId}
          currentId={assignedUserId}
          currentName={assignedUserName}
          teamMembers={teamMembers}
          onAlert={onAlert}
        />
        <StatusDropdown
          conversationId={conversationId}
          current={status}
          onAlert={onAlert}
        />
        <ConversationMenu
          conversationId={conversationId}
          contactName={contactName}
        />
      </div>
    </header>
  );
}
