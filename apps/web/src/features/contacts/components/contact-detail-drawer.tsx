"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Flag, Globe, Loader2, Mail, MapPin, MessageSquare, Phone, Send, Trash2, User as UserIcon } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import { WindowBadge } from "@/features/inbox/components/window-badge";
import { TagChip, TagAddButton } from "@/features/tags/components/tag-chip";
import { TagMultiPicker } from "@/features/tags/components/tag-multi-picker";
import { ContactStagePicker } from "@/features/contacts/components/contact-stage-picker";
import {
  AddFieldRow,
  prettifyKey,
  uniquePerContactKey,
} from "@/features/contacts/components/field-controls";
import { EditableField } from "@/features/inbox/components/contact-panel/editable-field";
import { EditableHeading } from "@/features/inbox/components/contact-panel/editable-heading";
import { Section } from "@/features/inbox/components/contact-panel/section";
import { apiFetch } from "@/lib/api/client-fetch";
import { dispatchLocalSocketEvent } from "@/lib/socket-client";
import { avatarGradient } from "@ccp/shared/utils/avatar-color";
import { formatPhone, initials } from "@ccp/shared/utils";
import type {
  Contact,
  ContactFieldDefinition,
  ContactPanelBuiltins,
  ContactStage,
  Tag,
} from "@ccp/shared/types";

/**
 * Right slide-over showing one contact in full, with inline editing. Replaces
 * the old centered edit modal. Reuses the inbox panel's editable leaf
 * components and the same optimistic pattern: every save fans a local
 * `contact:updated` so the contacts list row (which already reconciles that
 * event) updates instantly — no callback threading, no refetch.
 *
 * Phone stays read-only (WhatsApp identity). Stage + tags edit inline.
 */
export function ContactDetailDrawer({
  contact,
  fieldDefinitions,
  builtins,
  tagCatalog,
  stageCatalog,
  canManageFields,
  canManageStages,
  activeConversationId,
  lastInboundAt,
  onClose,
  onDelete,
  canDelete,
  onTagCreated,
  onTeamWideFieldAdded,
}: {
  contact: Contact;
  fieldDefinitions: ContactFieldDefinition[];
  /** Built-in field visibility — admin-controlled at /settings/contact-fields.
   *  Phone + name always render; everything else honors this map. */
  builtins: ContactPanelBuiltins;
  tagCatalog: Tag[];
  stageCatalog: ContactStage[];
  canManageFields: boolean;
  canManageStages: boolean;
  activeConversationId: string | null;
  lastInboundAt: string | null;
  onClose: () => void;
  /** Parent owns the confirm + DELETE + list removal + drawer close. */
  onDelete: () => void;
  /** Hide the delete button when the role lacks `contacts:delete`. */
  canDelete: boolean;
  onTagCreated: (tag: Tag) => void;
  onTeamWideFieldAdded: (def: ContactFieldDefinition) => void;
}) {
  // Local mirrors so edits feel instant; re-seeded only when a different
  // contact is opened. The optimistic dispatch keeps the list in sync.
  const [name, setName] = useState(contact.name);
  const [firstName, setFirstName] = useState(contact.firstName ?? "");
  const [lastName, setLastName] = useState(contact.lastName ?? "");
  const [email, setEmail] = useState(contact.email ?? "");
  const [location, setLocation] = useState(contact.location ?? "");
  const [language, setLanguage] = useState(contact.language ?? "");
  const [country, setCountry] = useState(contact.countryCode ?? "");
  const [customFields, setCustomFields] = useState<Record<string, string>>(
    contact.customFields ?? {},
  );
  const [tagIds, setTagIds] = useState<string[]>(contact.tagIds ?? []);
  const [stageId, setStageId] = useState<string | null>(contact.stageId ?? null);
  const [tags, setTags] = useState<Tag[]>(tagCatalog);
  const [tagPickerOpen, setTagPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const tagBoxRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  // Re-chat with a contact that has no thread (e.g. its conversation was
  // deleted). Get-or-create on the server, then open it in the inbox. When a
  // thread already exists this same endpoint just returns it — but the footer
  // only renders this button when there isn't one, so this is the create path.
  async function startChat() {
    if (starting) return;
    setStarting(true);
    setError(null);
    try {
      const res = await apiFetch("/api/conversations/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contactId: contact.id }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "Couldn't start chat");
        setStarting(false);
        return;
      }
      const { conversationId } = (await res.json()) as { conversationId: string };
      // Navigate into the inbox thread. Don't reset `starting` — we're leaving
      // this page, and clearing it would flash the button back to its idle
      // label mid-transition.
      router.push(`/inbox?c=${encodeURIComponent(conversationId)}`);
    } catch {
      setError("Couldn't start chat");
      setStarting(false);
    }
  }

  useEffect(() => {
    setName(contact.name);
    setFirstName(contact.firstName ?? "");
    setLastName(contact.lastName ?? "");
    setEmail(contact.email ?? "");
    setLocation(contact.location ?? "");
    setLanguage(contact.language ?? "");
    setCountry(contact.countryCode ?? "");
    setCustomFields(contact.customFields ?? {});
    setTagIds(contact.tagIds ?? []);
    setStageId(contact.stageId ?? null);
  }, [contact.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setTags(tagCatalog);
  }, [tagCatalog]);

  useEffect(() => {
    if (!tagPickerOpen) return;
    function handler(e: MouseEvent) {
      if (tagBoxRef.current && !tagBoxRef.current.contains(e.target as Node)) {
        setTagPickerOpen(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [tagPickerOpen]);

  /** Single save path. Optimistic local fan + PATCH; rollback on failure. */
  async function save(patch: {
    name?: string;
    firstName?: string | null;
    lastName?: string | null;
    email?: string | null;
    location?: string | null;
    language?: string | null;
    countryCode?: string | null;
    customFields?: Record<string, string | null>;
    stageId?: string | null;
  }): Promise<boolean> {
    setError(null);
    const nextCustomFields: Record<string, string> = { ...customFields };
    if (patch.customFields) {
      for (const [k, v] of Object.entries(patch.customFields)) {
        if (v === null) delete nextCustomFields[k];
        else nextCustomFields[k] = v;
      }
    }
    const optimistic: Contact = {
      ...contact,
      name: patch.name ?? name,
      firstName:
        "firstName" in patch ? patch.firstName ?? null : firstName || null,
      lastName:
        "lastName" in patch ? patch.lastName ?? null : lastName || null,
      email: "email" in patch ? patch.email ?? undefined : email || undefined,
      location:
        "location" in patch ? patch.location ?? undefined : location || undefined,
      language:
        "language" in patch ? patch.language ?? null : language || null,
      countryCode:
        "countryCode" in patch ? patch.countryCode ?? null : country || null,
      customFields: nextCustomFields,
      tagIds,
      stageId: "stageId" in patch ? patch.stageId ?? null : stageId,
    };
    // `optimistic: true` skips inbox-list resync + counts refetch during the
    // in-flight PATCH — see status-dropdown.tsx for the rationale.
    dispatchLocalSocketEvent("contact:updated", {
      teamId: contact.teamId,
      contact: optimistic,
      optimistic: true,
    });
    const res = await apiFetch(`/api/contacts/${contact.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? "Couldn't save");
      dispatchLocalSocketEvent("contact:updated", {
        teamId: contact.teamId,
        contact,
      });
      return false;
    }
    return true;
  }

  async function persistTagIds(nextIds: string[]) {
    const prev = tagIds;
    setTagIds(nextIds);
    setError(null);
    dispatchLocalSocketEvent("contact:updated", {
      teamId: contact.teamId,
      contact: { ...contact, tagIds: nextIds, stageId, customFields },
      optimistic: true,
    });
    const res = await apiFetch(`/api/contacts/${contact.id}/tags`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tagIds: nextIds }),
    });
    if (!res.ok) {
      setTagIds(prev);
      setError("Couldn't save tags");
      dispatchLocalSocketEvent("contact:updated", {
        teamId: contact.teamId,
        contact: { ...contact, tagIds: prev, stageId, customFields },
      });
    }
  }

  async function persistStage(next: string) {
    const prev = stageId;
    setStageId(next);
    const ok = await save({ stageId: next });
    if (!ok) setStageId(prev);
  }

  const appliedTags = tags.filter((t) => tagIds.includes(t.id));
  const definedKeys = new Set(fieldDefinitions.map((d) => d.key));
  const perContactKeys = Object.keys(customFields)
    .filter((k) => !definedKeys.has(k))
    .sort();

  return (
    <Sheet
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      side="right"
      contentClassName="w-full max-w-105"
      labelledBy="contact-drawer-name"
    >
      <div className="flex h-full flex-col">
        {/* Header */}
        <div className="flex flex-col items-center px-5 pb-4 pt-8">
          <Avatar className="size-16">
            <AvatarFallback
              className="text-lg text-white"
              style={{ backgroundImage: avatarGradient(contact.id) }}
            >
              {initials(name || contact.name)}
            </AvatarFallback>
          </Avatar>
          <div className="mt-3 w-full text-center">
            <div id="contact-drawer-name">
              <EditableHeading
                value={name}
                onSave={async (nextVal) => {
                  if (nextVal.trim() === name.trim()) return true;
                  const prev = name;
                  setName(nextVal);
                  const ok = await save({ name: nextVal });
                  if (!ok) setName(prev);
                  return ok;
                }}
              />
            </div>
            <div className="mt-0.5 truncate font-mono text-xs tabular-nums text-muted-foreground">
              {formatPhone(contact.phoneNumber)}
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5">
            <Badge variant={contact.source === "manual" ? "muted" : "success"}>
              {contact.source === "manual" ? "Added by you" : "Messaged you"}
            </Badge>
            <WindowBadge
              lastInboundAt={lastInboundAt}
              channel={contact.identityChannel ?? undefined}
              size="xs"
            />
          </div>
        </div>

        <Separator />

        <div className="min-h-0 flex-1 overflow-y-auto">
          <Section title="Stage">
            <ContactStagePicker
              stages={stageCatalog}
              currentStageId={stageId}
              onChange={persistStage}
              canManage={canManageStages}
              size="md"
            />
          </Section>

          <Separator />

          <Section title="Contact info">
            <div className="flex min-w-0 items-center gap-2 px-1 py-1 text-sm">
              <Phone className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate font-mono tabular-nums">{formatPhone(contact.phoneNumber)}</span>
            </div>
            {builtins.firstName && (
              <EditableField
                icon={UserIcon}
                label="First name"
                value={firstName}
                placeholder="—"
                onSave={async (next) => {
                  const trimmed = next.trim();
                  if (trimmed === (firstName ?? "").trim()) return true;
                  const prev = firstName;
                  setFirstName(trimmed);
                  const ok = await save({
                    firstName: trimmed === "" ? null : trimmed,
                  });
                  if (!ok) setFirstName(prev);
                  return ok;
                }}
              />
            )}
            {builtins.lastName && (
              <EditableField
                icon={UserIcon}
                label="Last name"
                value={lastName}
                placeholder="—"
                onSave={async (next) => {
                  const trimmed = next.trim();
                  if (trimmed === (lastName ?? "").trim()) return true;
                  const prev = lastName;
                  setLastName(trimmed);
                  const ok = await save({
                    lastName: trimmed === "" ? null : trimmed,
                  });
                  if (!ok) setLastName(prev);
                  return ok;
                }}
              />
            )}
            {builtins.email && (
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
            )}
            {builtins.location && (
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
            )}
            {builtins.language && (
              <EditableField
                icon={Globe}
                label="Language"
                value={language}
                placeholder="—"
                onSave={async (next) => {
                  const trimmed = next.trim();
                  if (trimmed === (language ?? "").trim()) return true;
                  const prev = language;
                  setLanguage(trimmed);
                  const ok = await save({
                    language: trimmed === "" ? null : trimmed,
                  });
                  if (!ok) setLanguage(prev);
                  return ok;
                }}
              />
            )}
            {builtins.country && (
              <EditableField
                icon={Flag}
                label="Country"
                value={country}
                placeholder="—"
                mono
                onSave={async (next) => {
                  const trimmed = next.trim().toUpperCase();
                  if (trimmed === (country ?? "").trim().toUpperCase()) return true;
                  const prev = country;
                  setCountry(trimmed);
                  const ok = await save({
                    countryCode: trimmed === "" ? null : trimmed,
                  });
                  if (!ok) setCountry(prev);
                  return ok;
                }}
              />
            )}

            {fieldDefinitions
              .filter((def) => def.isVisible)
              .map((def) => (
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
                const res = await apiFetch("/api/team/contact-fields", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ label }),
                });
                if (!res.ok) {
                  const body = (await res.json().catch(() => ({}))) as { error?: string };
                  setError(body.error ?? "Couldn't add field");
                  return false;
                }
                const { definition } = (await res.json()) as {
                  definition: ContactFieldDefinition;
                };
                onTeamWideFieldAdded(definition);
                return true;
              }}
            />

            {error && (
              <div className="mt-2 rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-2xs text-destructive">
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
                        prev.some((x) => x.id === tag.id)
                          ? prev
                          : [...prev, tag].sort((a, b) => a.name.localeCompare(b.name)),
                      );
                      onTagCreated(tag);
                      void persistTagIds([...tagIds, tag.id]);
                    }}
                  />
                </div>
              )}
            </div>
          </Section>
        </div>

        {/* Footer actions. A start-chat failure surfaces just above the
            buttons (the body-level `error` block is far up the scroll). */}
        <div className="border-t border-border">
          {error && !activeConversationId && (
            <div className="px-4 pt-2">
              <div className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-2xs text-destructive">
                {error}
              </div>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2 px-4 py-3">
          {activeConversationId ? (
            <Button asChild size="sm" className="flex-1 gap-1.5">
              <Link href={`/inbox/${activeConversationId}`}>
                <MessageSquare className="size-3.5" />
                Open chat
              </Link>
            </Button>
          ) : (
            <>
              {/* No thread (new contact, or its conversation was deleted) —
                  recreate + open it. "Send template" stays as the secondary
                  cold-outbound path. */}
              <Button
                size="sm"
                className="flex-1 gap-1.5"
                onClick={() => void startChat()}
                disabled={starting}
              >
                {starting ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <MessageSquare className="size-3.5" />
                )}
                Start chat
              </Button>
              <Button asChild variant="outline" size="sm" className="gap-1.5">
                <Link href={`/broadcasts/new?contactIds=${contact.id}`}>
                  <Send className="size-3.5" />
                  Template
                </Link>
              </Button>
            </>
          )}
          {canDelete && (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={onDelete}
            >
              <Trash2 className="size-3.5" />
              Delete
            </Button>
          )}
          </div>
        </div>
      </div>
    </Sheet>
  );
}
