"use client";

import {
  AtSign,
  ChevronDown,
  Hash,
  Inbox,
  MapPin,
  MessageSquare,
  Tag,
  User,
  UserCircle,
} from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@ccp/shared/utils";
import type { ContactFieldDefinition } from "@ccp/shared/types";
import { listAvailableTokens } from "@ccp/shared/field-tokens";

/**
 * Dropdown picker for inserting a contact-field token into a text input.
 *
 * The parent owns the input (and the cursor position). We don't try to be
 * clever about caret tracking — clicking a token fires `onInsert(token)` and
 * the parent decides whether to append, replace, or splice at cursor. This
 * is the same boundary the broadcast form already uses for its "Insert
 * variable" button.
 *
 * Visually a small text button that fits inline next to inputs and on
 * textarea toolbars — same `Button variant="outline" size="sm"` shape used
 * throughout the app.
 */
export function FieldTokenPicker({
  fieldDefinitions,
  onInsert,
  /** Override the trigger label; defaults to "Insert field". */
  label = "Insert field",
  className,
  /** Use `replace` mode in single-line inputs where mixing literal + token doesn't make sense. */
  hint,
  /**
   * Expose `$var.agent.*` tokens (snippets only — broadcasts have no single
   * agent per send so they leave this off).
   */
  includeAgent = false,
  /** Expose `$var.message.*` — workflow step editors for message_received. */
  includeMessage = false,
  /** Expose `$var.conversation.*` — workflow step editors for any
   *  conversation-bearing trigger. */
  includeConversation = false,
  /** Expose `$var.sender.*` alias tokens. Defaults to true when EITHER
   *  message or conversation is exposed — the sender alias is most useful
   *  in those workflow contexts. */
  includeSender,
}: {
  fieldDefinitions: ContactFieldDefinition[];
  onInsert: (token: string) => void;
  label?: string;
  className?: string;
  hint?: string;
  includeAgent?: boolean;
  includeMessage?: boolean;
  includeConversation?: boolean;
  includeSender?: boolean;
}) {
  const senderOn = includeSender ?? (includeMessage || includeConversation);
  const tokens = listAvailableTokens(fieldDefinitions, {
    includeAgent,
    includeMessage,
    includeConversation,
    includeSender: senderOn,
  });
  const builtins = tokens.filter((t) => t.group === "builtin");
  const customs = tokens.filter((t) => t.group === "custom");
  const senders = tokens.filter((t) => t.group === "sender");
  const messages = tokens.filter((t) => t.group === "message");
  const conversations = tokens.filter((t) => t.group === "conversation");
  const agents = tokens.filter((t) => t.group === "agent");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex h-7 items-center gap-1 rounded-md border border-border bg-background px-2 text-2xs font-medium text-muted-foreground transition-colors",
            "hover:border-primary/40 hover:text-foreground",
            className,
          )}
        >
          <Tag className="size-3" />
          {label}
          <ChevronDown className="size-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        // Cap to the space available below the trigger (Radix sets the var)
        // and scroll — the full token list is ~28 rows and otherwise runs off
        // the bottom of the screen.
        className="max-h-(--radix-dropdown-menu-content-available-height) min-w-55 overflow-y-auto scrollbar-thin"
      >
        <DropdownMenuLabel className="text-3xs font-semibold uppercase tracking-wide text-muted-foreground">
          Contact
        </DropdownMenuLabel>
        {builtins.map((t) => (
          <DropdownMenuItem
            key={t.token}
            onSelect={() => onInsert(t.token)}
            className="flex items-center gap-2 text-xs"
          >
            {iconFor(t.token)}
            <span className="flex-1">{t.label}</span>
            <code className="rounded bg-muted px-1 py-0.5 text-3xs text-muted-foreground">
              {compactToken(t.token)}
            </code>
          </DropdownMenuItem>
        ))}
        {customs.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-3xs font-semibold uppercase tracking-wide text-muted-foreground">
              Custom fields
            </DropdownMenuLabel>
            {customs.map((t) => (
              <DropdownMenuItem
                key={t.token}
                onSelect={() => onInsert(t.token)}
                className="flex items-center gap-2 text-xs"
              >
                <Hash className="size-3.5 text-muted-foreground" />
                <span className="flex-1 truncate">{t.label}</span>
                <code className="rounded bg-muted px-1 py-0.5 text-3xs text-muted-foreground">
                  {compactToken(t.token)}
                </code>
              </DropdownMenuItem>
            ))}
          </>
        )}
        {senders.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-3xs font-semibold uppercase tracking-wide text-muted-foreground">
              Sender
            </DropdownMenuLabel>
            {senders.map((t) => (
              <DropdownMenuItem
                key={t.token}
                onSelect={() => onInsert(t.token)}
                className="flex items-center gap-2 text-xs"
              >
                <UserCircle className="size-3.5 text-muted-foreground" />
                <span className="flex-1 truncate">{t.label}</span>
                <code className="rounded bg-muted px-1 py-0.5 text-3xs text-muted-foreground">
                  {compactToken(t.token)}
                </code>
              </DropdownMenuItem>
            ))}
          </>
        )}
        {messages.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-3xs font-semibold uppercase tracking-wide text-muted-foreground">
              Trigger message
            </DropdownMenuLabel>
            {messages.map((t) => (
              <DropdownMenuItem
                key={t.token}
                onSelect={() => onInsert(t.token)}
                className="flex items-center gap-2 text-xs"
              >
                <MessageSquare className="size-3.5 text-muted-foreground" />
                <span className="flex-1 truncate">{t.label}</span>
                <code className="rounded bg-muted px-1 py-0.5 text-3xs text-muted-foreground">
                  {compactToken(t.token)}
                </code>
              </DropdownMenuItem>
            ))}
          </>
        )}
        {conversations.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-3xs font-semibold uppercase tracking-wide text-muted-foreground">
              Conversation
            </DropdownMenuLabel>
            {conversations.map((t) => (
              <DropdownMenuItem
                key={t.token}
                onSelect={() => onInsert(t.token)}
                className="flex items-center gap-2 text-xs"
              >
                <Inbox className="size-3.5 text-muted-foreground" />
                <span className="flex-1 truncate">{t.label}</span>
                <code className="rounded bg-muted px-1 py-0.5 text-3xs text-muted-foreground">
                  {compactToken(t.token)}
                </code>
              </DropdownMenuItem>
            ))}
          </>
        )}
        {agents.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-3xs font-semibold uppercase tracking-wide text-muted-foreground">
              Agent
            </DropdownMenuLabel>
            {agents.map((t) => (
              <DropdownMenuItem
                key={t.token}
                onSelect={() => onInsert(t.token)}
                className="flex items-center gap-2 text-xs"
              >
                <UserCircle className="size-3.5 text-muted-foreground" />
                <span className="flex-1 truncate">{t.label}</span>
                <code className="rounded bg-muted px-1 py-0.5 text-3xs text-muted-foreground">
                  {compactToken(t.token)}
                </code>
              </DropdownMenuItem>
            ))}
          </>
        )}
        {hint && (
          <>
            <DropdownMenuSeparator />
            <div className="px-2 py-1.5 text-2xs leading-relaxed text-muted-foreground">
              {hint}
            </div>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function iconFor(token: string) {
  if (token.includes("name")) return <User className="size-3.5 text-muted-foreground" />;
  if (token.includes("phone")) return <Hash className="size-3.5 text-muted-foreground" />;
  if (token.includes("email")) return <AtSign className="size-3.5 text-muted-foreground" />;
  if (token.includes("location")) return <MapPin className="size-3.5 text-muted-foreground" />;
  return <Hash className="size-3.5 text-muted-foreground" />;
}

function compactToken(token: string): string {
  // "$var.contact.name" → "contact.name" — easier to scan in a tight UI.
  return token.replace(/^\$var\./, "");
}
