"use client";

import { Search as SearchIcon } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ContactStageStepper } from "@/components/contacts/contact-stage-picker";
import { avatarGradient } from "@/lib/avatar-color";
import { formatPhone, initials } from "@/lib/utils";
import type { ContactStage, ConversationStatus, User } from "@/lib/types";

import { AssignmentDropdown } from "./assignment-dropdown";
import { ConversationMenu } from "./conversation-menu";
import { StatusDropdown } from "./status-dropdown";

export function ThreadHeader({
  conversationId,
  contactId,
  contactName,
  phone,
  status,
  assignedUserId,
  assignedUserName,
  teamMembers,
  onAlert,
  onOpenSearch,
  stageCatalog,
  currentStageId,
  onStageChange,
  canManageStages,
}: {
  conversationId: string;
  contactId: string;
  contactName: string;
  phone: string | null;
  status: ConversationStatus;
  assignedUserId: string | null;
  assignedUserName: string | null;
  teamMembers: User[];
  /** Surface server errors via the app's modal alert. */
  onAlert: (title: string, description?: string) => Promise<void>;
  /** Open the in-conversation search overlay. */
  onOpenSearch: () => void;
  stageCatalog: ContactStage[];
  currentStageId: string | null;
  onStageChange: (stageId: string) => Promise<void>;
  canManageStages: boolean;
}) {
  return (
    <header className="flex h-15 shrink-0 items-center gap-3 border-b border-border px-4">
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
