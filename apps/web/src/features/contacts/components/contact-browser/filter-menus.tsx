"use client";

import { useMemo } from "react";
import { Check } from "lucide-react";

import { Input } from "@/components/ui/input";
import { CHANNEL_LABEL, ChannelBadge } from "@/features/inbox/components/channel-badge";
import { LIVE_CHANNELS } from "@ccp/shared/providers/capabilities";
import { tagColorClasses } from "@ccp/shared/utils/tag-colors";
import { cn } from "@ccp/shared/utils";
import type { ContactStage, ContactFieldDefinition } from "@ccp/shared/types";

import type {
  ChannelFilter,
  FieldFilter,
  ReachFilter,
  SourceFilter,
  StageFilter,
  WindowFilter,
} from "./filter-types";

// ---------------------------------------------------------------------------
// Shared menu primitives
// ---------------------------------------------------------------------------

function MenuLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 pb-1 pt-2 text-3xs font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </div>
  );
}

/** Single-select row with a leading dot/swatch slot and a trailing check. */
function RadioRow({
  active,
  onClick,
  leading,
  children,
}: {
  active: boolean;
  onClick: () => void;
  leading?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-accent",
        active && "bg-accent/40",
      )}
    >
      {leading}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {active && <Check className="size-3.5 shrink-0 text-primary" />}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Stage filter menu — vertical radio list: Any / <stages> / No stage
// ---------------------------------------------------------------------------

export function StageFilterMenu({
  stages,
  value,
  onChange,
}: {
  stages: ContactStage[];
  value: StageFilter;
  onChange: (next: StageFilter) => void;
}) {
  const sorted = useMemo(
    () => [...stages].sort((a, b) => a.position - b.position),
    [stages],
  );
  return (
    <div className="w-56 py-1">
      <RadioRow active={value === "any"} onClick={() => onChange("any")}>
        Any stage
      </RadioRow>
      {sorted.map((s) => (
        <RadioRow
          key={s.id}
          active={value === s.id}
          onClick={() => onChange(s.id)}
          leading={
            <span
              className={cn(
                "size-2 shrink-0 rounded-full",
                tagColorClasses(s.color).solid,
              )}
            />
          }
        >
          {s.name}
        </RadioRow>
      ))}
      <RadioRow
        active={value === "none"}
        onClick={() => onChange("none")}
        leading={<span className="size-2 shrink-0 rounded-full border border-border" />}
      >
        No stage
      </RadioRow>
    </div>
  );
}

// ---------------------------------------------------------------------------
// "More" menu — lower-frequency filters: Source, 24h window, custom fields
// ---------------------------------------------------------------------------

export function MoreFilterMenu({
  sourceFilter,
  onSourceChange,
  channelFilter = "any",
  onChannelChange,
  reachFilter = "any",
  onReachChange,
  accountFilter = null,
  onAccountChange,
  accounts = [],
  windowFilter,
  onWindowChange,
  fieldFilter,
  onFieldChange,
  fieldDefinitions,
}: {
  sourceFilter: SourceFilter;
  onSourceChange: (v: SourceFilter) => void;
  channelFilter?: ChannelFilter;
  /** Omit to hide the channel section (e.g. surfaces scoped to one channel). */
  onChannelChange?: (v: ChannelFilter) => void;
  reachFilter?: ReachFilter;
  /** Omit to hide the reachability section (e.g. the audience picker, which must
   *  not narrow the set the user is assembling). */
  onReachChange?: (v: ReachFilter) => void;
  /** ONE account on the channel — a specific number / Page / handle. */
  accountFilter?: string | null;
  /** Omit to hide the account section. */
  onAccountChange?: (v: string | null) => void;
  /** The workspace's accounts, already filtered to the live channels. */
  accounts?: Array<{ id: string; channel: string; name: string }>;
  windowFilter: WindowFilter;
  /** Omit to hide the 24h-window section (e.g. surfaces that don't filter on it). */
  onWindowChange?: (v: WindowFilter) => void;
  fieldFilter: FieldFilter | null;
  onFieldChange: (v: FieldFilter | null) => void;
  fieldDefinitions: ContactFieldDefinition[];
}) {
  return (
    <div className="w-64 py-1">
      <MenuLabel>Source</MenuLabel>
      <RadioRow active={sourceFilter === "all"} onClick={() => onSourceChange("all")}>
        Everyone
      </RadioRow>
      <RadioRow
        active={sourceFilter === "inbound"}
        onClick={() => onSourceChange("inbound")}
      >
        Messaged me
      </RadioRow>
      <RadioRow
        active={sourceFilter === "manual"}
        onClick={() => onSourceChange("manual")}
      >
        Added by me
      </RadioRow>

      {/* HOW you can contact them — the dimension a campaign is built on. The
          contacts page opens on "Has phone", which is why this reads as a normal
          filter (and shows a removable chip) rather than a hidden rule. */}
      {onReachChange && (
        <>
          <MenuLabel>Reachable by</MenuLabel>
          <RadioRow active={reachFilter === "any"} onClick={() => onReachChange("any")}>
            Any
          </RadioRow>
          <RadioRow active={reachFilter === "phone"} onClick={() => onReachChange("phone")}>
            Has phone number
          </RadioRow>
          <RadioRow active={reachFilter === "email"} onClick={() => onReachChange("email")}>
            Has email address
          </RadioRow>
        </>
      )}

      {onChannelChange && (
        <>
          <MenuLabel>Channel</MenuLabel>
          <RadioRow
            active={channelFilter === "any"}
            onClick={() => onChannelChange("any")}
          >
            Any channel
          </RadioRow>
          {[...LIVE_CHANNELS].map((ch) => (
            <RadioRow
              key={ch}
              active={channelFilter === ch}
              onClick={() => onChannelChange(ch)}
              leading={<ChannelBadge channel={ch} className="size-3.5 shrink-0" />}
            >
              {CHANNEL_LABEL[ch]}
            </RadioRow>
          ))}
        </>
      )}

      {/* WHICH of our numbers / Pages / handles the contact talks to. Only
          worth showing when there is more than one to choose between — on a
          single-account workspace it is a menu with one option. When a channel
          is also selected, narrow to that channel's accounts so the two
          controls can't contradict each other. */}
      {onAccountChange &&
        (() => {
          const visible = accounts.filter(
            (a) => channelFilter === "any" || a.channel === channelFilter,
          );
          if (visible.length < 2) return null;
          return (
            <>
              <MenuLabel>Account</MenuLabel>
              <RadioRow active={accountFilter === null} onClick={() => onAccountChange(null)}>
                Any account
              </RadioRow>
              {visible.map((a) => (
                <RadioRow
                  key={a.id}
                  active={accountFilter === a.id}
                  onClick={() => onAccountChange(a.id)}
                  leading={
                    <ChannelBadge
                      channel={a.channel as Parameters<typeof ChannelBadge>[0]["channel"]}
                      className="size-3.5 shrink-0"
                    />
                  }
                >
                  {a.name}
                </RadioRow>
              ))}
            </>
          );
        })()}

      {onWindowChange && (
        <>
          <MenuLabel>24-hour window</MenuLabel>
          <RadioRow active={windowFilter === "any"} onClick={() => onWindowChange("any")}>
            Any
          </RadioRow>
          <RadioRow
            active={windowFilter === "open"}
            onClick={() => onWindowChange("open")}
            leading={<span className="size-2 shrink-0 rounded-full bg-success-fg" />}
          >
            Open
          </RadioRow>
          <RadioRow
            active={windowFilter === "closed"}
            onClick={() => onWindowChange("closed")}
            leading={<span className="size-2 shrink-0 rounded-full bg-destructive" />}
          >
            Closed
          </RadioRow>
        </>
      )}

      {fieldDefinitions.length > 0 && (
        <>
          <MenuLabel>Custom fields</MenuLabel>
          {/* Select-type fields filter by OPTION (exact match on the stored
              option id); text fields keep the contains input. One field
              filter at a time either way — picking one clears the other. */}
          {fieldDefinitions
            .filter((def) => def.type === "select")
            .map((def) => {
              const active = fieldFilter?.key === def.key ? fieldFilter.value : null;
              return (
                <div key={def.id}>
                  <div className="px-3 pb-0.5 pt-1 text-3xs text-muted-foreground">
                    {def.label}
                  </div>
                  <RadioRow
                    active={active === null}
                    onClick={() => {
                      if (active !== null) onFieldChange(null);
                    }}
                  >
                    Any
                  </RadioRow>
                  {(def.options ?? []).map((o) => (
                    <RadioRow
                      key={o.id}
                      active={active === o.id}
                      onClick={() =>
                        onFieldChange(
                          active === o.id
                            ? null
                            : { key: def.key, value: o.id, mode: "equals" },
                        )
                      }
                      leading={
                        <span
                          className={cn(
                            "size-2 shrink-0 rounded-full",
                            tagColorClasses(o.color).solid,
                          )}
                        />
                      }
                    >
                      {o.name}
                    </RadioRow>
                  ))}
                </div>
              );
            })}
          <div className="space-y-1.5 px-3 pb-2 pt-1">
            {fieldDefinitions
              .filter((def) => def.type !== "select")
              .map((def) => {
                const active = fieldFilter?.key === def.key;
                return (
                  <Input
                    key={def.id}
                    value={active ? fieldFilter.value : ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      onFieldChange(v ? { key: def.key, value: v } : null);
                    }}
                    placeholder={`${def.label} contains…`}
                    aria-label={`Filter by ${def.label}`}
                    className="h-8 text-xs"
                  />
                );
              })}
          </div>
        </>
      )}
    </div>
  );
}
