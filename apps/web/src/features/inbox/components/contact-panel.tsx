"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, Mail, Phone, MapPin, Clock, FileText, Loader2, UserRound } from "lucide-react";

import {
  AddFieldRow,
  prettifyKey,
  uniquePerContactKey,
} from "@/features/contacts/components/field-controls";
import { TagChip, TagAddButton } from "@/features/tags/components/tag-chip";
import { TagMultiPicker } from "@/features/tags/components/tag-multi-picker";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { LocalTime } from "@/components/local-time";
import { avatarGradient } from "@ccp/shared/utils/avatar-color";
import { getClientSocket } from "@/lib/socket-client";
import { cn, formatPhone, initials } from "@ccp/shared/utils";
import type {
  ContactFieldDefinition,
  ConversationStatus,
  ConversationWithRefs,
  Tag,
  User,
} from "@ccp/shared/types";

import { EditableField } from "./contact-panel/editable-field";
import { EditableHeading } from "./contact-panel/editable-heading";
import { ReadOnlyRow } from "./contact-panel/read-only-row";
import { Section } from "./contact-panel/section";

const STATUS_LABEL: Record<ConversationStatus, string> = {
  open: "Open",
  pending: "Pending",
  closed: "Closed",
};

/** Shallow string-record equality used to compare customField maps. */
function shallowJsonEqual(
  a: Record<string, string>,
  b: Record<string, string>,
): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (a[k] !== b[k]) return false;
  return true;
}

/** Order-insensitive array equality used to compare tagIds. */
function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const seen = new Set(a);
  for (const x of b) if (!seen.has(x)) return false;
  return true;
}

interface PanelProps {
  data: ConversationWithRefs;
  fieldDefinitions: ContactFieldDefinition[];
  /** Whether the current user can add/rename/delete team-wide field definitions. */
  canManageFields: boolean;
  /** Team-wide tag catalog. Used by the tag picker for select/create. */
  tagCatalog: Tag[];
  /**
   * Team roster used to render the account-manager picker. Distinct from the
   * per-thread `assignedUser` on the conversation — this assignee is the
   * contact's cross-thread owner (Contact.assignedUserId).
   */
  teamMembers: User[];
}

export function ContactPanel({
  data,
  fieldDefinitions,
  canManageFields,
  tagCatalog,
  teamMembers,
}: PanelProps) {
  const { contact, conversation, messages, notes } = data;
  const router = useRouter();

  // ------------------------------------------------------------------
  // Live stats. ContactPanel is a SIBLING of MessageThread (see
  // app/inbox/[conversationId]/page.tsx) — both receive the same
  // server-rendered `data` snapshot, but only MessageThread runs
  // useConversationEvents, so its prop stays frozen on this side. We
  // mirror the small slice the panel renders (status + counts) by
  // subscribing to the same events here. Two listeners for the same
  // events is cheap; the alternative would be lifting the hook into
  // a shared parent, which is a much larger refactor for this one
  // panel.
  // ------------------------------------------------------------------
  const [liveStatus, setLiveStatus] = useState<ConversationStatus>(
    conversation.status,
  );
  const [liveMessageCount, setLiveMessageCount] = useState<number>(
    data.messageCount ?? messages.length,
  );
  const [liveNoteCount, setLiveNoteCount] = useState<number>(
    data.noteCount ?? notes.length,
  );

  // Reset whenever the user switches to a different conversation OR the
  // server snapshot changes (router.refresh after a mutation). Without
  // this the panel would keep showing the previous thread's counts when
  // the prop changes.
  useEffect(() => {
    setLiveStatus(conversation.status);
    setLiveMessageCount(data.messageCount ?? messages.length);
    setLiveNoteCount(data.noteCount ?? notes.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.id, conversation.status, data.messageCount, data.noteCount]);

  useEffect(() => {
    const socket = getClientSocket();
    const conversationId = conversation.id;

    const onStatus: Parameters<typeof socket.on<"conversation:status">>[1] = (
      payload,
    ) => {
      if (payload.conversationId !== conversationId) return;
      setLiveStatus(payload.status);
    };
    const onMessageNew: Parameters<typeof socket.on<"message:new">>[1] = (
      payload,
    ) => {
      if (payload.conversationId !== conversationId) return;
      setLiveMessageCount((n) => n + 1);
    };
    const onNoteNew: Parameters<typeof socket.on<"note:new">>[1] = (payload) => {
      if (payload.conversationId !== conversationId) return;
      setLiveNoteCount((n) => n + 1);
    };
    const onNoteDeleted: Parameters<typeof socket.on<"note:deleted">>[1] = (
      payload,
    ) => {
      if (payload.conversationId !== conversationId) return;
      setLiveNoteCount((n) => Math.max(0, n - 1));
    };

    socket.on("conversation:status", onStatus);
    socket.on("message:new", onMessageNew);
    socket.on("note:new", onNoteNew);
    socket.on("note:deleted", onNoteDeleted);

    return () => {
      socket.off("conversation:status", onStatus);
      socket.off("message:new", onMessageNew);
      socket.off("note:new", onNoteNew);
      socket.off("note:deleted", onNoteDeleted);
    };
  }, [conversation.id]);

  // Local mirror of editable contact fields. Server is the source of truth —
  // we mirror here so edits feel instant. router.refresh() pulls the canonical
  // row back after every save.
  // Phone number is intentionally NOT mirrored: it's the WhatsApp identity
  // used to dedupe inbound webhooks, so it's read-only. Display straight from
  // `contact.phoneNumber`.
  const [name, setName] = useState(contact.name);
  const [email, setEmail] = useState(contact.email ?? "");
  const [location, setLocation] = useState(contact.location ?? "");
  const [customFields, setCustomFields] = useState<Record<string, string>>(
    contact.customFields ?? {},
  );
  const [tagIds, setTagIds] = useState<string[]>(contact.tagIds ?? []);
  // Local mirror of the team catalog so newly-created tags appear immediately
  // without waiting for a router.refresh round-trip.
  const [tags, setTags] = useState<Tag[]>(tagCatalog);
  const [tagPickerOpen, setTagPickerOpen] = useState(false);
  const [tagSaveError, setTagSaveError] = useState<string | null>(null);
  const tagBoxRef = useRef<HTMLDivElement>(null);

  // Account-manager assignee — Contact.assignedUserId. Distinct from the
  // conversation's per-thread assignee. Server-authoritative (no optimistic
  // patch — the PATCH route handles persistence and the socket echo refreshes
  // both this panel and any other tab open on this contact).
  const [accountManagerId, setAccountManagerId] = useState<string | null>(
    contact.assignedUserId ?? null,
  );
  const [accountManagerPending, setAccountManagerPending] = useState(false);
  const [accountManagerError, setAccountManagerError] = useState<string | null>(null);

  // Re-sync when navigating to a different conversation. Without this the
  // panel would render the previous contact's edits against the new contact.
  useEffect(() => {
    setName(contact.name);
    setEmail(contact.email ?? "");
    setLocation(contact.location ?? "");
    setCustomFields(contact.customFields ?? {});
    setTagIds(contact.tagIds ?? []);
    setAccountManagerId(contact.assignedUserId ?? null);
    setAccountManagerError(null);
    setTagPickerOpen(false);
    setTagSaveError(null);
  }, [
    contact.id,
    contact.name,
    contact.email,
    contact.location,
    contact.customFields,
    contact.tagIds,
    contact.assignedUserId,
  ]);

  // Keep our local tag catalog in sync with the server-fetched one (changes
  // when the user navigates between conversations or another agent creates a
  // tag and router.refresh fires).
  useEffect(() => {
    setTags(tagCatalog);
  }, [tagCatalog]);

  // Server snapshot we last seeded local state from. Used to tell whether the
  // user has unsaved local edits — anything local that differs from the
  // snapshot is "dirty." On a teammate update we use this to decide between:
  //   - silent live-apply  (no dirty fields → no conflict)
  //   - banner + park       (dirty fields the teammate's update would change)
  const serverSnapshotRef = useRef({
    name: contact.name,
    email: contact.email ?? "",
    location: contact.location ?? "",
    customFields: contact.customFields ?? {},
    tagIds: contact.tagIds ?? [],
  });
  useEffect(() => {
    serverSnapshotRef.current = {
      name: contact.name,
      email: contact.email ?? "",
      location: contact.location ?? "",
      customFields: contact.customFields ?? {},
      tagIds: contact.tagIds ?? [],
    };
  }, [
    contact.id,
    contact.name,
    contact.email,
    contact.location,
    contact.customFields,
    contact.tagIds,
  ]);

  // Parked teammate update. Set when we DETECTED in-progress local edits a
  // socket event would overwrite. Cleared on Reload (apply the teammate's
  // changes) or Dismiss (keep mine — server already has the teammate's
  // values, our save will overwrite them which matches last-write-wins).
  const [pendingRemote, setPendingRemote] = useState<{
    name: string;
    email: string;
    location: string;
    customFields: Record<string, string>;
    tagIds: string[];
  } | null>(null);

  // Live merge of teammate edits. ContactPanel is a sibling of MessageThread
  // and doesn't share its useConversationEvents state, so we listen directly.
  //
  // Conflict policy: when the incoming snapshot differs from what we'd write
  // for any locally-dirty field, park it and show a banner so the agent
  // knows their in-progress edits are about to lose to a teammate's save.
  // Previously (auto-memory: "Contact field edit race") this overwrote
  // silently — documented as intentional last-write-wins, but the user has
  // no warning that their typing just got eaten.
  useEffect(() => {
    const socket = getClientSocket();
    const contactId = contact.id;
    const onContactUpdated: Parameters<typeof socket.on<"contact:updated">>[1] = (
      payload,
    ) => {
      if (payload.contact.id !== contactId) return;
      // Account-manager isn't a free-text field, so a teammate's change can't
      // race a half-typed edit on this side. Apply it unconditionally — same
      // pattern as the message-thread's `conversation:assigned` reducer.
      const incomingAssignee = payload.contact.assignedUserId ?? null;
      setAccountManagerId(incomingAssignee);
      const incoming = {
        name: payload.contact.name,
        email: payload.contact.email ?? "",
        location: payload.contact.location ?? "",
        customFields: payload.contact.customFields ?? {},
        tagIds: payload.contact.tagIds ?? [],
      };
      const snapshot = serverSnapshotRef.current;
      const dirty =
        name !== snapshot.name ||
        email !== snapshot.email ||
        location !== snapshot.location ||
        !shallowJsonEqual(customFields, snapshot.customFields) ||
        !arraysEqual(tagIds, snapshot.tagIds);
      if (!dirty) {
        // Common path: live-collab. Apply silently + re-seed snapshot so the
        // panel stays in sync with the rest of the team without any banner.
        setName(incoming.name);
        setEmail(incoming.email);
        setLocation(incoming.location);
        setCustomFields(incoming.customFields);
        setTagIds(incoming.tagIds);
        serverSnapshotRef.current = incoming;
        return;
      }
      // Dirty + incoming matches what we'd save anyway → echo of our own
      // round-trip. Just re-seed the snapshot so we stop being "dirty"
      // without spamming a banner.
      const wouldOverwrite =
        incoming.name !== name ||
        incoming.email !== email ||
        incoming.location !== location ||
        !shallowJsonEqual(incoming.customFields, customFields) ||
        !arraysEqual(incoming.tagIds, tagIds);
      if (!wouldOverwrite) {
        serverSnapshotRef.current = incoming;
        return;
      }
      // Dirty + would actually overwrite → park + banner.
      setPendingRemote(incoming);
    };
    // Bulk paths suppress the per-contact `contact:updated` frame and emit a
    // single `contacts:bulk_updated` instead. Without this listener, a
    // teammate bulk-tagging the open contact would leave this panel stale
    // until the user navigated away.
    //
    // Payload deliberately omits the contact (the event exists to AVOID N
    // frames), so we can't park a snapshot like the per-contact path does.
    // Behavior:
    //   - clean local fields → router.refresh() pulls canonical, the
    //     contact-prop useEffect (line 172) re-seeds local state silently.
    //   - dirty local fields → leave them alone. Last-write-wins on next
    //     save, matching the pre-this-listener behavior. Rare in practice
    //     (single agent mid-edit while a bulk op hits the same contact).
    const onContactsBulkUpdated: Parameters<
      typeof socket.on<"contacts:bulk_updated">
    >[1] = (payload) => {
      if (!payload.contactIds.includes(contactId)) return;
      const snapshot = serverSnapshotRef.current;
      const dirty =
        name !== snapshot.name ||
        email !== snapshot.email ||
        location !== snapshot.location ||
        !shallowJsonEqual(customFields, snapshot.customFields) ||
        !arraysEqual(tagIds, snapshot.tagIds);
      if (dirty) return;
      router.refresh();
    };
    socket.on("contact:updated", onContactUpdated);
    socket.on("contacts:bulk_updated", onContactsBulkUpdated);
    return () => {
      socket.off("contact:updated", onContactUpdated);
      socket.off("contacts:bulk_updated", onContactsBulkUpdated);
    };
  }, [contact.id, name, email, location, customFields, tagIds, router]);

  function acceptPendingRemote() {
    if (!pendingRemote) return;
    setName(pendingRemote.name);
    setEmail(pendingRemote.email);
    setLocation(pendingRemote.location);
    setCustomFields(pendingRemote.customFields);
    setTagIds(pendingRemote.tagIds);
    serverSnapshotRef.current = pendingRemote;
    setPendingRemote(null);
  }
  function dismissPendingRemote() {
    // Keep local edits. The serverSnapshotRef stays on the OLD snapshot so
    // the next save still shows as "user-initiated" rather than instantly
    // re-banner-ing. The next contact.updated echo of OUR save will re-seed
    // it naturally.
    setPendingRemote(null);
  }

  // Close the picker when the user clicks outside.
  useEffect(() => {
    if (!tagPickerOpen) return;
    function handler(e: MouseEvent) {
      if (!tagBoxRef.current) return;
      if (!tagBoxRef.current.contains(e.target as Node)) setTagPickerOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [tagPickerOpen]);

  const [saving, startSaving] = useTransition();
  const [error, setError] = useState<string | null>(null);

  /**
   * Single save path for every field. Takes a partial patch, applies it
   * optimistically, fires PATCH, rolls back on error. Returns true on success
   * so the row component can switch out of edit mode only when it stuck.
   */
  async function save(patch: {
    name?: string;
    email?: string | null;
    location?: string | null;
    customFields?: Record<string, string | null>;
  }): Promise<boolean> {
    setError(null);
    const res = await fetch(`/api/contacts/${contact.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? "Couldn't save");
      return false;
    }
    startSaving(() => router.refresh());
    return true;
  }

  /**
   * Account-manager picker. PATCHes `Contact.assignedUserId`; the server's
   * `contact:updated` socket echo re-syncs every open tab + the cached thread
   * snapshot in inbox-shell. No optimistic update — the contact panel sits a
   * single round-trip from the active thread, so the perceived lag is the
   * same as the conversation-header AssignmentDropdown.
   */
  async function persistAccountManager(nextId: string | null) {
    if (nextId === accountManagerId || accountManagerPending) return;
    setAccountManagerPending(true);
    setAccountManagerError(null);
    try {
      const res = await fetch(`/api/contacts/${contact.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assignedUserId: nextId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setAccountManagerError(body.error ?? "Couldn't update");
        return;
      }
      // Apply the local value now — the socket echo will arrive a beat later
      // and become a no-op via the equality bail in the listener above.
      setAccountManagerId(nextId);
      startSaving(() => router.refresh());
    } catch (err) {
      setAccountManagerError(err instanceof Error ? err.message : "Network error");
    } finally {
      setAccountManagerPending(false);
    }
  }

  // PUT replaces the whole set (server semantics), so we hand it the full
  // next array. Optimistic: paint locally first, rollback on error.
  async function persistTagIds(nextIds: string[]) {
    const prevIds = tagIds;
    setTagIds(nextIds);
    setTagSaveError(null);
    const res = await fetch(`/api/contacts/${contact.id}/tags`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tagIds: nextIds }),
    });
    if (!res.ok) {
      setTagIds(prevIds);
      setTagSaveError("Failed to save tags");
      return;
    }
    startSaving(() => router.refresh());
  }

  // Resolve ids to full tag objects in catalog (alphabetical) order. Ids
  // pointing at deleted tags are silently dropped — the server already
  // filtered cross-team ids, but a tag could have been deleted between the
  // initial render and now.
  const appliedTags = tags.filter((t) => tagIds.includes(t.id));

  // Team-wide field rows: always rendered, even when blank, so the team
  // schema is visible. Per-contact extras are keys present in customFields
  // that DON'T have a matching definition.
  const definedKeys = new Set(fieldDefinitions.map((d) => d.key));
  const perContactKeys = Object.keys(customFields)
    .filter((k) => !definedKeys.has(k))
    .sort();

  return (
    <aside className="hidden h-full w-[320px] shrink-0 flex-col border-l border-border bg-sidebar text-sidebar-foreground lg:flex">
      {pendingRemote ? (
        <div className="flex items-start gap-2 border-b border-amber-300/40 bg-amber-50 px-4 py-2 text-[12px] text-amber-900 dark:border-amber-700/40 dark:bg-amber-900/20 dark:text-amber-200">
          <span className="mt-px inline-block size-1.5 shrink-0 rounded-full bg-amber-500" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">A teammate just updated this contact</div>
            <div className="opacity-80">
              Your in-progress edits would be overwritten. Reload to see
              their changes, or keep editing and your save will win.
            </div>
            <div className="mt-1.5 flex gap-1.5">
              <button
                type="button"
                onClick={acceptPendingRemote}
                className="rounded-md bg-amber-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-amber-700"
              >
                Reload
              </button>
              <button
                type="button"
                onClick={dismissPendingRemote}
                className="rounded-md border border-amber-400/60 px-2 py-0.5 text-[11px] font-medium text-amber-900 hover:bg-amber-100 dark:text-amber-100 dark:hover:bg-amber-800/30"
              >
                Keep mine
              </button>
            </div>
          </div>
        </div>
      ) : null}
      <ScrollArea className="flex-1">
        <div className="flex flex-col items-center px-5 pt-6 pb-4">
          <Avatar className="size-16">
            <AvatarFallback
              className="text-lg text-white"
              style={{ backgroundImage: avatarGradient(contact.id) }}
            >
              {initials(name || contact.name)}
            </AvatarFallback>
          </Avatar>
          <div className="mt-3 w-full text-center">
            <EditableHeading
              value={name}
              onSave={async (next) => {
                if (next.trim() === name.trim()) return true;
                const prev = name;
                setName(next);
                const ok = await save({ name: next });
                if (!ok) setName(prev);
                return ok;
              }}
            />
            <div className="mt-0.5 font-mono text-xs text-muted-foreground">
              {formatPhone(contact.phoneNumber)}
            </div>
          </div>
          <div className="mt-3 flex flex-wrap justify-center gap-1.5">
            <Badge variant="muted">WhatsApp</Badge>
            <Badge variant="success">Active</Badge>
            {/* Distinguishes contacts an agent created (e.g. via the New
                Contact dialog or CSV import) from contacts we got because a
                customer messaged us. The list page filters by this too. */}
            <Badge variant={contact.source === "manual" ? "muted" : "success"}>
              {contact.source === "manual" ? "Added by you" : "Messaged you"}
            </Badge>
          </div>
        </div>

        <Separator />

        <Section
          title="Contact info"
          right={
            saving ? <Loader2 className="size-3 animate-spin text-muted-foreground" /> : null
          }
        >
          {/* Phone is read-only: it's the WhatsApp identity used to dedupe
              inbound webhooks and route conversations. Editing it would
              silently break the link to the customer's WhatsApp account, so
              we don't allow it from the UI. */}
          <ReadOnlyRow
            icon={Phone}
            label="Phone"
            mono
            value={formatPhone(contact.phoneNumber)}
          />
          <EditableField
            icon={Mail}
            label="Email"
            value={email}
            placeholder="—"
            onSave={async (next) => {
              const trimmed = next.trim();
              if (trimmed === (email ?? "").trim()) return true;
              const prev = email;
              setEmail(trimmed);
              const ok = await save({ email: trimmed === "" ? null : trimmed });
              if (!ok) setEmail(prev);
              return ok;
            }}
          />
          <EditableField
            icon={MapPin}
            label="Location"
            value={location}
            placeholder="—"
            onSave={async (next) => {
              const trimmed = next.trim();
              if (trimmed === (location ?? "").trim()) return true;
              const prev = location;
              setLocation(trimmed);
              const ok = await save({ location: trimmed === "" ? null : trimmed });
              if (!ok) setLocation(prev);
              return ok;
            }}
          />
          <ReadOnlyRow
            icon={Clock}
            label="First contacted"
            value={
              messages[0] ? (
                <LocalTime iso={messages[0].timestamp} format="shortDate" />
              ) : (
                "—"
              )
            }
          />

          {/* Team-wide fields. Rendered in their definition order. */}
          {fieldDefinitions.map((def) => (
            <EditableField
              key={def.id}
              label={def.label}
              value={customFields[def.key] ?? ""}
              placeholder="—"
              onSave={async (next) => {
                const trimmed = next.trim();
                const current = customFields[def.key] ?? "";
                if (trimmed === current) return true;
                const prev = customFields;
                setCustomFields({ ...prev, [def.key]: trimmed });
                const ok = await save({
                  customFields: { [def.key]: trimmed === "" ? null : trimmed },
                });
                if (!ok) setCustomFields(prev);
                return ok;
              }}
            />
          ))}

          {/* Per-contact one-off keys. Each carries a delete button. */}
          {perContactKeys.map((key) => (
            <EditableField
              key={key}
              label={prettifyKey(key)}
              value={customFields[key] ?? ""}
              placeholder="—"
              onSave={async (next) => {
                const trimmed = next.trim();
                const current = customFields[key] ?? "";
                if (trimmed === current) return true;
                const prev = customFields;
                const nextMap = { ...prev };
                if (trimmed === "") delete nextMap[key];
                else nextMap[key] = trimmed;
                setCustomFields(nextMap);
                const ok = await save({
                  customFields: { [key]: trimmed === "" ? null : trimmed },
                });
                if (!ok) setCustomFields(prev);
                return ok;
              }}
              onDelete={async () => {
                const prev = customFields;
                const nextMap = { ...prev };
                delete nextMap[key];
                setCustomFields(nextMap);
                const ok = await save({ customFields: { [key]: null } });
                if (!ok) setCustomFields(prev);
              }}
            />
          ))}

          <AddFieldRow
            canManageFields={canManageFields}
            onAddPerContact={async (label) => {
              const key = uniquePerContactKey(label, Object.keys(customFields));
              setCustomFields({ ...customFields, [key]: "" });
              await save({ customFields: { [key]: "" } });
            }}
            onAddTeamWide={async (label) => {
              const res = await fetch("/api/team/contact-fields", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ label }),
              });
              if (!res.ok) {
                const body = (await res.json().catch(() => ({}))) as { error?: string };
                setError(body.error ?? "Couldn't add field");
                return false;
              }
              startSaving(() => router.refresh());
              return true;
            }}
          />

          {error && (
            <div className="mt-2 rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
              {error}
            </div>
          )}
        </Section>

        <Separator />

        <Section title="Account manager">
          <AccountManagerPicker
            currentId={accountManagerId}
            teamMembers={teamMembers}
            pending={accountManagerPending}
            onChange={(next) => void persistAccountManager(next)}
          />
          {accountManagerError && (
            <div className="mt-2 text-[11px] text-destructive">
              {accountManagerError}
            </div>
          )}
        </Section>

        <Separator />

        <Section title="Tags">
          <div ref={tagBoxRef} className="relative flex flex-wrap items-center gap-1.5">
            {appliedTags.map((t) => (
              <TagChip
                key={t.id}
                tag={t}
                size="sm"
                onRemove={() => void persistTagIds(tagIds.filter((id) => id !== t.id))}
              />
            ))}
            <TagAddButton size="sm" onClick={() => setTagPickerOpen((v) => !v)} />
            {tagPickerOpen && (
              <div className="absolute left-0 top-full z-20 mt-1">
                <TagMultiPicker
                  tags={tags}
                  selectedIds={tagIds}
                  onSelectedChange={(next) => void persistTagIds(next)}
                  onCreated={(tag) => {
                    setTags((prev) =>
                      [...prev, tag].sort((a, b) => a.name.localeCompare(b.name)),
                    );
                    void persistTagIds([...tagIds, tag.id]);
                  }}
                />
              </div>
            )}
          </div>
          {tagSaveError && (
            <div className="mt-2 text-[10px] text-destructive">{tagSaveError}</div>
          )}
        </Section>

        <Separator />

        <Section title="Conversation">
          <ReadOnlyRow
            icon={FileText}
            label="Messages"
            // True server-side totals, kept in sync by the live listeners
            // above. `messages.length` from props is just the paginated
            // slice loaded into the thread and lies on long conversations.
            value={`${liveMessageCount} message${liveMessageCount === 1 ? "" : "s"} · ${liveNoteCount} note${liveNoteCount === 1 ? "" : "s"}`}
          />
          <ReadOnlyRow
            icon={Clock}
            label="Status"
            value={STATUS_LABEL[liveStatus]}
          />
        </Section>

      </ScrollArea>
    </aside>
  );
}

/**
 * Cross-thread "Account manager" assignee picker. Mirrors the conversation
 * header's `AssignmentDropdown` shape so the inbox feels coherent, but writes
 * to `Contact.assignedUserId` (not `Conversation.assignedUserId`). The two
 * fields are intentionally independent — the per-thread assignee tracks
 * "who's handling THIS chat right now", the account manager tracks "who
 * owns this customer across every chat they ever have."
 */
function AccountManagerPicker({
  currentId,
  teamMembers,
  pending,
  onChange,
}: {
  currentId: string | null;
  teamMembers: User[];
  pending: boolean;
  onChange: (next: string | null) => void;
}) {
  const current = currentId ? teamMembers.find((u) => u.id === currentId) ?? null : null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={pending}
          className={cn(
            "flex h-8 w-full items-center gap-2 rounded-md border border-input bg-background px-2.5 text-[13px] transition-colors hover:bg-accent hover:text-accent-foreground",
            pending && "opacity-60",
          )}
        >
          {current ? (
            <>
              <span className="inline-flex size-5 items-center justify-center rounded-full bg-secondary text-[10px] font-medium">
                {initials(current.name)}
              </span>
              <span className="truncate font-normal">{current.name}</span>
            </>
          ) : (
            <>
              <UserRound className="size-4 text-muted-foreground" />
              <span className="text-muted-foreground">Unassigned</span>
            </>
          )}
          <ChevronDown className="ml-auto size-3.5 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>Account manager</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onChange(null)}>
          {currentId === null && <Check className="size-3.5" />}
          <span className={cn("text-muted-foreground", currentId === null && "ml-1")}>
            Unassigned
          </span>
        </DropdownMenuItem>
        {teamMembers.map((u) => (
          <DropdownMenuItem key={u.id} onSelect={() => onChange(u.id)}>
            {currentId === u.id ? (
              <Check className="size-3.5" />
            ) : (
              <span className="inline-flex size-5 items-center justify-center rounded-full bg-secondary text-[10px] font-medium">
                {initials(u.name)}
              </span>
            )}
            <span className="truncate">{u.name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
