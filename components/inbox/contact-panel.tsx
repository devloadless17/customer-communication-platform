"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Mail, Phone, MapPin, Clock, FileText, Loader2 } from "lucide-react";

import {
  AddFieldRow,
  prettifyKey,
  uniquePerContactKey,
} from "@/components/contacts/field-controls";
import { TagChip, TagAddButton } from "@/components/tags/tag-chip";
import { TagMultiPicker } from "@/components/tags/tag-multi-picker";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { LocalTime } from "@/components/local-time";
import { avatarGradient } from "@/lib/avatar-color";
import { getClientSocket } from "@/lib/socket/client";
import { formatPhone, initials } from "@/lib/utils";
import type {
  ContactFieldDefinition,
  ConversationStatus,
  ConversationWithRefs,
  Tag,
} from "@/lib/types";

import { EditableField } from "./contact-panel/editable-field";
import { EditableHeading } from "./contact-panel/editable-heading";
import { ReadOnlyRow } from "./contact-panel/read-only-row";
import { Section } from "./contact-panel/section";

const STATUS_LABEL: Record<ConversationStatus, string> = {
  open: "Open",
  pending: "Pending",
  closed: "Closed",
};

interface PanelProps {
  data: ConversationWithRefs;
  fieldDefinitions: ContactFieldDefinition[];
  /** Whether the current user can add/rename/delete team-wide field definitions. */
  canManageFields: boolean;
  /** Team-wide tag catalog. Used by the tag picker for select/create. */
  tagCatalog: Tag[];
}

function formatShortDate(iso: string, tz?: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: tz,
  });
}

export function ContactPanel({
  data,
  fieldDefinitions,
  canManageFields,
  tagCatalog,
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

  // Re-sync when navigating to a different conversation. Without this the
  // panel would render the previous contact's edits against the new contact.
  useEffect(() => {
    setName(contact.name);
    setEmail(contact.email ?? "");
    setLocation(contact.location ?? "");
    setCustomFields(contact.customFields ?? {});
    setTagIds(contact.tagIds ?? []);
    setTagPickerOpen(false);
    setTagSaveError(null);
  }, [
    contact.id,
    contact.name,
    contact.email,
    contact.location,
    contact.customFields,
    contact.tagIds,
  ]);

  // Keep our local tag catalog in sync with the server-fetched one (changes
  // when the user navigates between conversations or another agent creates a
  // tag and router.refresh fires).
  useEffect(() => {
    setTags(tagCatalog);
  }, [tagCatalog]);

  // Live merge of teammate edits to this contact. ContactPanel is a sibling
  // of MessageThread and doesn't share its useConversationEvents state, so
  // we listen directly. Re-seeds every local mirror in one shot — the
  // semantic is "last write wins", same as the server's DB write. If the
  // current user happens to be mid-typing into a field, their in-progress
  // text is overwritten — matches the conflict resolution the backend
  // would apply if both saves landed anyway, and avoids the alternative
  // of silently dropping the teammate's update.
  useEffect(() => {
    const socket = getClientSocket();
    const contactId = contact.id;
    const onContactUpdated: Parameters<typeof socket.on<"contact:updated">>[1] = (
      payload,
    ) => {
      if (payload.contact.id !== contactId) return;
      setName(payload.contact.name);
      setEmail(payload.contact.email ?? "");
      setLocation(payload.contact.location ?? "");
      setCustomFields(payload.contact.customFields ?? {});
      setTagIds(payload.contact.tagIds ?? []);
    };
    socket.on("contact:updated", onContactUpdated);
    return () => {
      socket.off("contact:updated", onContactUpdated);
    };
  }, [contact.id]);

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
                <LocalTime iso={messages[0].timestamp} format={formatShortDate} />
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
