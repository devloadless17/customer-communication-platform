"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Loader2 } from "lucide-react";

import {
  INBOX_VIEW_NAME_MAX,
  summarizeInboxViewFilters,
  type InboxView,
  type InboxViewAssignee,
  type InboxViewFilters,
  type InboxViewIcon,
} from "@ccp/shared/inbox-views/types";
import { LIVE_CHANNELS } from "@ccp/shared/providers/capabilities";
import { TAG_COLORS, type Channel, type ContactStage, type Tag, type TagColor, type User } from "@ccp/shared/types";
import type { ConversationStatus } from "@ccp/shared/types";
import { cn } from "@ccp/shared/utils";
import { tagColorClasses } from "@ccp/shared/utils/tag-colors";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { CHANNEL_LABEL } from "@/features/inbox/components/channel-badge";
import { useChannelAccounts } from "@/features/inbox/contexts/channel-accounts-context";
import { VIEW_ICON_OPTIONS, viewIcon } from "./view-icon";

/**
 * Create / edit a saved inbox view.
 *
 * The whole dialog is one scrollable column of small, self-explaining groups
 * rather than a tabbed or wizard flow: every criterion is optional and
 * independent, so there is no order to walk the user through, and hiding half
 * of them behind a step would only make it harder to see what the view
 * actually does. The live summary line at the bottom is the payoff — it reads
 * back the filter in the same words the sidebar will, so nobody has to save
 * and click to find out.
 */

const STATUSES: Array<{ id: ConversationStatus; label: string }> = [
  { id: "open", label: "Open" },
  { id: "pending", label: "Pending" },
  { id: "closed", label: "Closed" },
];

const ASSIGNEE_MODES = [
  { id: "anyone", label: "Anyone" },
  { id: "me", label: "Me" },
  { id: "unassigned", label: "Unassigned" },
  { id: "users", label: "Specific people" },
] as const;

export function ViewBuilderDialog({
  open,
  onClose,
  existing,
  canShare,
  stages,
  tags,
  teammates,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  /** Absent = create. Present = edit that view. */
  existing?: InboxView | null;
  /** Whether this agent may create/edit SHARED views. */
  canShare: boolean;
  stages: ContactStage[];
  tags: Tag[];
  teammates: User[];
  onSubmit: (input: {
    name: string;
    color: string;
    icon: string;
    visibility: "personal" | "shared";
    filters: InboxViewFilters;
  }) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  const [color, setColor] = useState<TagColor>("slate");
  const [icon, setIcon] = useState<InboxViewIcon>("filter");
  const [shared, setShared] = useState(false);
  const [filters, setFilters] = useState<InboxViewFilters>({});
  const [saving, setSaving] = useState(false);

  // Re-seed every time the dialog opens. Without the `open` dep, editing view A,
  // closing, then opening view B would show A's criteria until something else
  // re-rendered — the classic "dialog remembers the last thing" bug.
  useEffect(() => {
    if (!open) return;
    setName(existing?.name ?? "");
    setColor((existing?.color as TagColor) ?? "slate");
    setIcon((existing?.icon as InboxViewIcon) ?? "filter");
    setShared(existing?.visibility === "shared");
    setFilters(existing?.filters ?? {});
    setSaving(false);
  }, [open, existing]);

  const liveChannels = useMemo(
    () => (Array.from(LIVE_CHANNELS) as Channel[]).sort(),
    [],
  );

  // The workspace's connected accounts — offered as a filter only for channels
  // that hold MORE THAN ONE (with one account, the channel chip already says
  // it). The criteria plumbing (`channelAccountIds`: shared types → schema →
  // where-builder) predates this UI; the builder was the only missing link.
  const { byId: accountsById } = useChannelAccounts();
  const filterableAccounts = useMemo(() => {
    const all = [...accountsById.values()];
    const perChannel = new Map<string, number>();
    for (const a of all) perChannel.set(a.channel, (perChannel.get(a.channel) ?? 0) + 1);
    return all
      .filter((a) => (perChannel.get(a.channel) ?? 0) > 1)
      .sort((a, b) => a.channel.localeCompare(b.channel) || a.name.localeCompare(b.name));
  }, [accountsById]);

  const summary = useMemo(
    () =>
      summarizeInboxViewFilters(filters, {
        stageNames: Object.fromEntries(stages.map((s) => [s.id, s.name])),
        tagNames: Object.fromEntries(tags.map((t) => [t.id, t.name])),
        userNames: Object.fromEntries(teammates.map((u) => [u.id, u.name])),
        channelLabels: CHANNEL_LABEL,
        accountNames: Object.fromEntries(
          [...accountsById.values()].map((a) => [a.id, a.name]),
        ),
      }),
    [filters, stages, tags, teammates, accountsById],
  );

  const assigneeMode = filters.assignee?.kind ?? "anyone";
  const selectedUserIds =
    filters.assignee?.kind === "users" ? filters.assignee.userIds : [];

  function toggle<T>(list: T[] | undefined, value: T): T[] | undefined {
    const next = (list ?? []).includes(value)
      ? (list ?? []).filter((v) => v !== value)
      : [...(list ?? []), value];
    // Collapse an emptied list back to `undefined` — "no opinion" — so the
    // saved document never carries `[]`, which reads as a filter but behaves
    // as none.
    return next.length ? next : undefined;
  }

  async function handleSubmit() {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    const ok = await onSubmit({
      name: trimmed,
      color,
      icon,
      visibility: shared ? "shared" : "personal",
      filters,
    });
    setSaving(false);
    if (ok) onClose();
  }

  const Icon = viewIcon(icon);

  return (
    <Dialog open={open} onClose={onClose}>
      <DialogContent
        className="flex max-w-lg flex-col gap-0 p-0"
        ariaLabel={existing ? "Edit view" : "New view"}
      >
        <header className="border-b border-border px-5 py-4">
          <h2 className="text-sm font-semibold">
            {existing ? "Edit view" : "New view"}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            A saved filter over your inbox. Leave a section untouched to include
            everything.
          </p>
        </header>

        <div className="flex flex-col gap-5 overflow-y-auto px-5 py-4">
          {/* ---- Identity ---- */}
          <section className="flex flex-col gap-2">
            <label htmlFor="view-name" className="text-xs font-medium">
              Name
            </label>
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "flex size-9 shrink-0 items-center justify-center rounded-md",
                  tagColorClasses(color).chip,
                )}
              >
                <Icon className="size-4" />
              </span>
              <Input
                id="view-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={INBOX_VIEW_NAME_MAX}
                placeholder="Escalations"
                autoFocus
              />
            </div>
          </section>

          <Group label="Icon">
            <div className="flex flex-wrap gap-1">
              {VIEW_ICON_OPTIONS.map(({ key, Icon: Opt }) => (
                <button
                  key={key}
                  type="button"
                  aria-label={key}
                  aria-pressed={icon === key}
                  onClick={() => setIcon(key)}
                  className={cn(
                    "flex size-8 cursor-pointer items-center justify-center rounded-md border transition-colors",
                    icon === key
                      ? "border-primary bg-accent text-foreground"
                      : "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  <Opt className="size-4" />
                </button>
              ))}
            </div>
          </Group>

          <Group label="Colour">
            <div className="flex flex-wrap gap-1.5">
              {TAG_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={c}
                  aria-pressed={color === c}
                  onClick={() => setColor(c)}
                  className={cn(
                    "size-6 cursor-pointer rounded-full transition-transform",
                    tagColorClasses(c).solid,
                    // Ring, not scale: a scale transform on hover shifts the
                    // row and makes the palette twitch under the cursor.
                    color === c && "ring-2 ring-ring ring-offset-2 ring-offset-popover",
                  )}
                />
              ))}
            </div>
          </Group>

          <hr className="border-border" />

          {/* ---- Criteria ---- */}
          <Group label="Status" hint="Any status when nothing is selected">
            <ChipRow>
              {STATUSES.map((s) => (
                <Chip
                  key={s.id}
                  active={!!filters.statuses?.includes(s.id)}
                  onClick={() =>
                    setFilters((f) => ({ ...f, statuses: toggle(f.statuses, s.id) }))
                  }
                >
                  {s.label}
                </Chip>
              ))}
            </ChipRow>
          </Group>

          <Group label="Assigned to">
            <ChipRow>
              {ASSIGNEE_MODES.map((m) => (
                <Chip
                  key={m.id}
                  active={assigneeMode === m.id}
                  onClick={() =>
                    setFilters((f) => ({
                      ...f,
                      assignee:
                        m.id === "users"
                          ? { kind: "users", userIds: selectedUserIds }
                          : ({ kind: m.id } as InboxViewAssignee),
                    }))
                  }
                >
                  {m.label}
                </Chip>
              ))}
            </ChipRow>
            {assigneeMode === "users" && (
              <ChipRow className="mt-2">
                {teammates.map((u) => (
                  <Chip
                    key={u.id}
                    active={selectedUserIds.includes(u.id)}
                    onClick={() =>
                      setFilters((f) => {
                        const current =
                          f.assignee?.kind === "users" ? f.assignee.userIds : [];
                        const next = current.includes(u.id)
                          ? current.filter((id) => id !== u.id)
                          : [...current, u.id];
                        return { ...f, assignee: { kind: "users", userIds: next } };
                      })
                    }
                  >
                    {u.name}
                  </Chip>
                ))}
              </ChipRow>
            )}
            {assigneeMode === "me" && (
              <p className="mt-1.5 text-2xs text-muted-foreground">
                Resolved per viewer — in a shared view, each teammate sees their
                own work.
              </p>
            )}
          </Group>

          <Group label="Channel">
            <ChipRow>
              {liveChannels.map((c) => (
                <Chip
                  key={c}
                  active={!!filters.channels?.includes(c)}
                  onClick={() =>
                    setFilters((f) => ({ ...f, channels: toggle(f.channels, c) }))
                  }
                >
                  {CHANNEL_LABEL[c]}
                </Chip>
              ))}
            </ChipRow>
          </Group>

          {filterableAccounts.length > 0 && (
            <Group label="Account">
              <ChipRow>
                {filterableAccounts.map((a) => (
                  <Chip
                    key={a.id}
                    active={!!filters.channelAccountIds?.includes(a.id)}
                    onClick={() =>
                      setFilters((f) => ({
                        ...f,
                        channelAccountIds: toggle(f.channelAccountIds, a.id),
                      }))
                    }
                  >
                    {CHANNEL_LABEL[a.channel]} · {a.name}
                  </Chip>
                ))}
              </ChipRow>
              <p className="mt-1.5 text-2xs text-muted-foreground">
                Narrow to specific numbers or accounts on a channel that has
                several connected.
              </p>
            </Group>
          )}

          {stages.length > 0 && (
            <Group label="Stage">
              <ChipRow>
                {stages.map((s) => (
                  <Chip
                    key={s.id}
                    active={!!filters.stageIds?.includes(s.id)}
                    onClick={() =>
                      setFilters((f) => ({ ...f, stageIds: toggle(f.stageIds, s.id) }))
                    }
                  >
                    <span
                      className={cn(
                        "size-1.5 rounded-full",
                        tagColorClasses(s.color).solid,
                      )}
                    />
                    {s.name}
                  </Chip>
                ))}
              </ChipRow>
            </Group>
          )}

          {tags.length > 0 && (
            <Group label="Tags">
              <ChipRow>
                {tags.map((t) => (
                  <Chip
                    key={t.id}
                    active={!!filters.tagIds?.includes(t.id)}
                    onClick={() =>
                      setFilters((f) => ({ ...f, tagIds: toggle(f.tagIds, t.id) }))
                    }
                  >
                    <span
                      className={cn(
                        "size-1.5 rounded-full",
                        tagColorClasses(t.color).solid,
                      )}
                    />
                    {t.name}
                  </Chip>
                ))}
              </ChipRow>
              {!!filters.tagIds?.length && (
                <ChipRow className="mt-2">
                  <Chip
                    active={filters.tagMatch !== "all"}
                    onClick={() => setFilters((f) => ({ ...f, tagMatch: "any" }))}
                  >
                    Any of these
                  </Chip>
                  <Chip
                    active={filters.tagMatch === "all"}
                    onClick={() => setFilters((f) => ({ ...f, tagMatch: "all" }))}
                  >
                    All of these
                  </Chip>
                </ChipRow>
              )}
            </Group>
          )}

          <Group label="Also">
            <div className="flex flex-col gap-2">
              <ToggleRow
                label="Only flagged conversations"
                checked={!!filters.hasOpenFlags}
                onChange={(v) =>
                  setFilters((f) => ({ ...f, hasOpenFlags: v || undefined }))
                }
              />
              <ToggleRow
                label="Only unread conversations"
                checked={!!filters.unreadOnly}
                onChange={(v) =>
                  setFilters((f) => ({ ...f, unreadOnly: v || undefined }))
                }
              />
            </div>
          </Group>

          {canShare && (
            <>
              <hr className="border-border" />
              <ToggleRow
                label="Share with the whole workspace"
                hint="Everyone sees it in their sidebar. Only people who can manage shared views may edit it."
                checked={shared}
                onChange={setShared}
              />
            </>
          )}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-border px-5 py-3">
          {/* The payoff: what this view will actually show, in the same words
              the sidebar tooltip uses. */}
          <p className="min-w-0 flex-1 truncate text-2xs text-muted-foreground" title={summary}>
            {summary}
          </p>
          <div className="flex shrink-0 gap-2">
            <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleSubmit} disabled={!name.trim() || saving}>
              {saving ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Check className="size-3.5" />
              )}
              {existing ? "Save" : "Create view"}
            </Button>
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

function Group({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2">
        <h3 className="text-xs font-medium">{label}</h3>
        {hint && <span className="text-2xs text-muted-foreground">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

function ChipRow({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={cn("flex flex-wrap gap-1.5", className)}>{children}</div>;
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex h-7 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors",
        active
          ? "border-primary bg-primary/10 font-medium text-foreground"
          : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-xs">{label}</p>
        {hint && <p className="mt-0.5 text-2xs text-muted-foreground">{hint}</p>}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </div>
  );
}
