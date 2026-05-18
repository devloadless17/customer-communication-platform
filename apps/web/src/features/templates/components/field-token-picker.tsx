"use client";

import { AtSign, ChevronDown, Hash, MapPin, Tag, User, UserCircle } from "lucide-react";

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
}: {
  fieldDefinitions: ContactFieldDefinition[];
  onInsert: (token: string) => void;
  label?: string;
  className?: string;
  hint?: string;
  includeAgent?: boolean;
}) {
  const tokens = listAvailableTokens(fieldDefinitions, { includeAgent });
  const builtins = tokens.filter((t) => t.group === "builtin");
  const customs = tokens.filter((t) => t.group === "custom");
  const agents = tokens.filter((t) => t.group === "agent");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex h-7 items-center gap-1 rounded-md border border-border bg-background px-2 text-[11px] font-medium text-muted-foreground transition-colors",
            "hover:border-primary/40 hover:text-foreground",
            className,
          )}
        >
          <Tag className="size-3" />
          {label}
          <ChevronDown className="size-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-55">
        <DropdownMenuLabel className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Contact
        </DropdownMenuLabel>
        {builtins.map((t) => (
          <DropdownMenuItem
            key={t.token}
            onSelect={() => onInsert(t.token)}
            className="flex items-center gap-2 text-[12px]"
          >
            {iconFor(t.token)}
            <span className="flex-1">{t.label}</span>
            <code className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
              {compactToken(t.token)}
            </code>
          </DropdownMenuItem>
        ))}
        {customs.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Custom fields
            </DropdownMenuLabel>
            {customs.map((t) => (
              <DropdownMenuItem
                key={t.token}
                onSelect={() => onInsert(t.token)}
                className="flex items-center gap-2 text-[12px]"
              >
                <Hash className="size-3.5 text-muted-foreground" />
                <span className="flex-1 truncate">{t.label}</span>
                <code className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                  {compactToken(t.token)}
                </code>
              </DropdownMenuItem>
            ))}
          </>
        )}
        {agents.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Agent
            </DropdownMenuLabel>
            {agents.map((t) => (
              <DropdownMenuItem
                key={t.token}
                onSelect={() => onInsert(t.token)}
                className="flex items-center gap-2 text-[12px]"
              >
                <UserCircle className="size-3.5 text-muted-foreground" />
                <span className="flex-1 truncate">{t.label}</span>
                <code className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                  {compactToken(t.token)}
                </code>
              </DropdownMenuItem>
            ))}
          </>
        )}
        {hint && (
          <>
            <DropdownMenuSeparator />
            <div className="px-2 py-1.5 text-[10.5px] leading-relaxed text-muted-foreground">
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
