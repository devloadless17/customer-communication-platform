"use client";

import { memo, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useSoftRefresh } from "@/hooks/use-soft-refresh";
import { Check, ChevronDown, ChevronLeft, Mail, Paperclip, Phone, MapPin, Clock, FileText, Loader2, PanelRightClose, UserRound, User as UserIcon, Globe, Flag } from "lucide-react";

import {
  AddFieldRow,
  prettifyKey,
  uniquePerContactKey,
} from "@/features/contacts/components/field-controls";
import { TagChip, TagAddButton } from "@/features/tags/components/tag-chip";
import { TagMultiPicker } from "@/features/tags/components/tag-multi-picker";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { LocalTime } from "@/components/local-time";
import { avatarGradient } from "@ccp/shared/utils/avatar-color";
import { apiFetch } from "@/lib/api/client-fetch";
import {
  dispatchLocalSocketEvent,
  dispatchLocalSocketEvents,
  getClientSocket,
} from "@/lib/socket-client";
import {
  buildOptimisticAssignment,
  buildOptimisticStatusChange,
  buildOptimisticTagAdded,
  buildOptimisticTagRemoved,
  rollbackOptimisticActivity,
} from "@/features/inbox/lib/optimistic-activity";
import { predictAssignmentStatus } from "@/features/inbox/lib/predict-status";
import {
  AVAILABILITY_DOT_CLASSES,
  AVAILABILITY_LABELS,
} from "@ccp/shared/presence";
import { usePresence } from "@/hooks/use-presence";
import { cn, formatPhone, initials } from "@ccp/shared/utils";
import type {
  ContactFieldDefinition,
  ContactPanelBuiltins,
  ConversationStatus,
  ConversationWithRefs,
  Tag,
  User,
} from "@ccp/shared/types";

import { AttachmentGallery } from "./attachments/attachment-gallery";
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
  /** Built-in field visibility (email / location / firstContacted). Phone is
   *  always rendered regardless. Admin-controlled from /settings/contact-fields. */
  builtins: ContactPanelBuiltins;
  /** Whether the current user can add/rename/delete team-wide field definitions. */
  canManageFields: boolean;
  /** Team-wide tag catalog. Used by the tag picker for select/create. */
  tagCatalog: Tag[];
  /** Team roster used to render the assignee picker. */
  teamMembers: User[];
  /** Current agent's display name — actor on optimistic activity pills
   *  (stage / tag changes made from this panel). */
  currentUserName: string;
  /** Server-read cookie so the panel SSRs in its persisted rail state (no
   *  expand→collapse flash). Default false (expanded). */
  initialCollapsed: boolean;
  /** Jump the thread to a specific message (id) — used by the Files tab so
   *  clicking "Jump" on an attachment scrolls + flashes the source bubble.
   *  Reuses the same `jumpTarget` state inbox-shell already drives for
   *  global search results. */
  onGoToMessage: (messageId: string) => void;
}

function ContactPanelImpl({
  data,
  fieldDefinitions,
  builtins,
  canManageFields,
  tagCatalog,
  teamMembers,
  currentUserName,
  initialCollapsed,
  onGoToMessage,
}: PanelProps) {
  const { contact, conversation, messages, notes } = data;
  const router = useRouter();
  const softRefresh = useSoftRefresh();

  // ------------------------------------------------------------------
  // Collapse-to-rail. Mirrors the left AppRail: the full 320px panel
  // collapses to a thin 48px rail showing only an expand button, and the
  // state persists in a cookie so the inbox page (RSC) SSRs the right width
  // on the next load with no flash. `transitionEnabled` skips the width
  // animation on first mount so a restored-collapsed state doesn't animate
  // open→closed on load.
  // ------------------------------------------------------------------
  // Seed from the server-read prop for an SSR-consistent first paint, then
  // re-sync from the live cookie on mount. The prop is frozen at page load, so
  // on a chat-switch remount (ThreadWorkspace is keyed by conversation id) it
  // can be stale relative to a toggle made since — the cookie is the truth.
  const [collapsed, setCollapsed] = useState<boolean>(initialCollapsed);
  const [transitionEnabled, setTransitionEnabled] = useState(false);
  // Two-tab view inside the expanded panel: the existing details surface
  // vs the per-conversation media gallery. State is local — switching chats
  // remounts the panel via the key={conversationId} on ThreadWorkspace, so
  // each chat starts on Details.
  const [view, setView] = useState<"details" | "files">("details");
  useEffect(() => {
    const fromCookie = document.cookie
      .split("; ")
      .find((c) => c.startsWith("contact-panel-collapsed="))
      ?.slice("contact-panel-collapsed=".length);
    if (fromCookie === "true" || fromCookie === "false") {
      setCollapsed(fromCookie === "true");
    }
    const raf = requestAnimationFrame(() => setTransitionEnabled(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    // Cookie (not localStorage) so the server layout reads it and SSRs the
    // correct width next load — that's what kills the flash. Default expanded,
    // so only an explicit "true" persists the collapsed rail.
    document.cookie = `contact-panel-collapsed=${String(next)}; path=/; max-age=31536000; samesite=lax`;
  }

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
    const onAssigned: Parameters<typeof socket.on<"conversation:assigned">>[1] = (
      payload,
    ) => {
      if (payload.conversationId !== conversationId) return;
      setAssigneeId(payload.assignedUser?.id ?? null);
    };

    socket.on("conversation:status", onStatus);
    socket.on("message:new", onMessageNew);
    socket.on("note:new", onNoteNew);
    socket.on("note:deleted", onNoteDeleted);
    socket.on("conversation:assigned", onAssigned);

    return () => {
      socket.off("conversation:status", onStatus);
      socket.off("message:new", onMessageNew);
      socket.off("note:new", onNoteNew);
      socket.off("note:deleted", onNoteDeleted);
      socket.off("conversation:assigned", onAssigned);
    };
  }, [conversation.id]);

  // Local mirror of editable contact fields. Server is the source of truth —
  // we mirror here so edits feel instant. router.refresh() pulls the canonical
  // row back after every save.
  // Phone number is intentionally NOT mirrored: it's the WhatsApp identity
  // used to dedupe inbound webhooks, so it's read-only. Display straight from
  // `contact.phoneNumber`.
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
  // Local mirror of the team catalog so newly-created tags appear immediately
  // without waiting for a router.refresh round-trip.
  const [tags, setTags] = useState<Tag[]>(tagCatalog);
  const [tagPickerOpen, setTagPickerOpen] = useState(false);
  const [tagSaveError, setTagSaveError] = useState<string | null>(null);
  const tagBoxRef = useRef<HTMLDivElement>(null);

  // Assignee — mirrors the thread header's AssignmentDropdown. Reads/writes
  // Conversation.assignedUserId so changes from above the chat reflect here
  // (and vice versa). No optimistic update — same single round-trip as the
  // header picker; the `conversation:assigned` socket echo keeps every open
  // tab in sync.
  const [assigneeId, setAssigneeId] = useState<string | null>(
    data.assignedUser?.id ?? null,
  );
  const [assigneePending, setAssigneePending] = useState(false);
  const [assigneeError, setAssigneeError] = useState<string | null>(null);

  // Re-sync when navigating to a different conversation. Without this the
  // panel would render the previous contact's edits against the new contact.
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
    setAssigneeId(data.assignedUser?.id ?? null);
    setAssigneeError(null);
    setTagPickerOpen(false);
    setTagSaveError(null);
  }, [
    contact.id,
    contact.name,
    contact.firstName,
    contact.lastName,
    contact.email,
    contact.location,
    contact.language,
    contact.countryCode,
    contact.customFields,
    contact.tagIds,
    data.assignedUser?.id,
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
    firstName: contact.firstName ?? "",
    lastName: contact.lastName ?? "",
    email: contact.email ?? "",
    location: contact.location ?? "",
    language: contact.language ?? "",
    country: contact.countryCode ?? "",
    customFields: contact.customFields ?? {},
    tagIds: contact.tagIds ?? [],
  });
  useEffect(() => {
    serverSnapshotRef.current = {
      name: contact.name,
      firstName: contact.firstName ?? "",
      lastName: contact.lastName ?? "",
      email: contact.email ?? "",
      location: contact.location ?? "",
      language: contact.language ?? "",
      country: contact.countryCode ?? "",
      customFields: contact.customFields ?? {},
      tagIds: contact.tagIds ?? [],
    };
  }, [
    contact.id,
    contact.name,
    contact.firstName,
    contact.lastName,
    contact.email,
    contact.location,
    contact.language,
    contact.countryCode,
    contact.customFields,
    contact.tagIds,
  ]);

  // Per-render mirror of every editable field, written each commit so the
  // socket-listener effect below can read latest values without listing them
  // as effect deps. Listing them produced a teardown + rebind of the
  // socket.on / off pair on EVERY keystroke (auto-memory: P1-1 in the
  // 2026-05-26 pre-deploy audit) — wasteful closure allocation per
  // character on a hot path. Refs aren't reactive, so writing one per
  // render is cheap; the listener stays bound from mount to unmount.
  const editableRef = useRef({
    name,
    firstName,
    lastName,
    email,
    location,
    language,
    country,
    customFields,
    tagIds,
  });
  editableRef.current = {
    name,
    firstName,
    lastName,
    email,
    location,
    language,
    country,
    customFields,
    tagIds,
  };

  // Parked teammate update. Set when we DETECTED in-progress local edits a
  // socket event would overwrite. Cleared on Reload (apply the teammate's
  // changes) or Dismiss (keep mine — server already has the teammate's
  // values, our save will overwrite them which matches last-write-wins).
  const [pendingRemote, setPendingRemote] = useState<{
    name: string;
    firstName: string;
    lastName: string;
    email: string;
    location: string;
    language: string;
    country: string;
    customFields: Record<string, string>;
    tagIds: string[];
  } | null>(null);

  // Stable ref mirror of softRefresh — useSoftRefresh returns a fresh fn each
  // render, listing it as an effect dep would also force a re-bind per render.
  const softRefreshRef = useRef(softRefresh);
  softRefreshRef.current = softRefresh;

  // Live merge of teammate edits. ContactPanel is a sibling of MessageThread
  // and doesn't share its useConversationEvents state, so we listen directly.
  //
  // Conflict policy: when the incoming snapshot differs from what we'd write
  // for any locally-dirty field, park it and show a banner so the agent
  // knows their in-progress edits are about to lose to a teammate's save.
  // Previously (auto-memory: "Contact field edit race") this overwrote
  // silently — documented as intentional last-write-wins, but the user has
  // no warning that their typing just got eaten.
  //
  // Effect deps are [contact.id] only — every per-render dirty-check value
  // is read through `editableRef.current` so a keystroke does NOT tear down
  // and re-bind the two socket listeners. (Pre-2026-05-26: 11 deps incl.
  // every editable state, every keystroke rebound — wasteful on a hot path.)
  useEffect(() => {
    const socket = getClientSocket();
    const contactId = contact.id;
    const onContactUpdated: Parameters<typeof socket.on<"contact:updated">>[1] = (
      payload,
    ) => {
      if (payload.contact.id !== contactId) return;
      const incoming = {
        name: payload.contact.name,
        firstName: payload.contact.firstName ?? "",
        lastName: payload.contact.lastName ?? "",
        email: payload.contact.email ?? "",
        location: payload.contact.location ?? "",
        language: payload.contact.language ?? "",
        country: payload.contact.countryCode ?? "",
        customFields: payload.contact.customFields ?? {},
        tagIds: payload.contact.tagIds ?? [],
      };
      const snapshot = serverSnapshotRef.current;
      const live = editableRef.current;
      const dirty =
        live.name !== snapshot.name ||
        live.firstName !== snapshot.firstName ||
        live.lastName !== snapshot.lastName ||
        live.email !== snapshot.email ||
        live.location !== snapshot.location ||
        live.language !== snapshot.language ||
        live.country !== snapshot.country ||
        !shallowJsonEqual(live.customFields, snapshot.customFields) ||
        !arraysEqual(live.tagIds, snapshot.tagIds);
      if (!dirty) {
        // Common path: live-collab. Apply silently + re-seed snapshot so the
        // panel stays in sync with the rest of the team without any banner.
        setName(incoming.name);
        setFirstName(incoming.firstName);
        setLastName(incoming.lastName);
        setEmail(incoming.email);
        setLocation(incoming.location);
        setLanguage(incoming.language);
        setCountry(incoming.country);
        setCustomFields(incoming.customFields);
        setTagIds(incoming.tagIds);
        serverSnapshotRef.current = incoming;
        return;
      }
      // Dirty + incoming matches what we'd save anyway → echo of our own
      // round-trip. Just re-seed the snapshot so we stop being "dirty"
      // without spamming a banner.
      const wouldOverwrite =
        incoming.name !== live.name ||
        incoming.firstName !== live.firstName ||
        incoming.lastName !== live.lastName ||
        incoming.email !== live.email ||
        incoming.location !== live.location ||
        incoming.language !== live.language ||
        incoming.country !== live.country ||
        !shallowJsonEqual(incoming.customFields, live.customFields) ||
        !arraysEqual(incoming.tagIds, live.tagIds);
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
      const live = editableRef.current;
      const dirty =
        live.name !== snapshot.name ||
        live.firstName !== snapshot.firstName ||
        live.lastName !== snapshot.lastName ||
        live.email !== snapshot.email ||
        live.location !== snapshot.location ||
        live.language !== snapshot.language ||
        live.country !== snapshot.country ||
        !shallowJsonEqual(live.customFields, snapshot.customFields) ||
        !arraysEqual(live.tagIds, snapshot.tagIds);
      if (dirty) return;
      softRefreshRef.current();
    };
    socket.on("contact:updated", onContactUpdated);
    socket.on("contacts:bulk_updated", onContactsBulkUpdated);
    return () => {
      socket.off("contact:updated", onContactUpdated);
      socket.off("contacts:bulk_updated", onContactsBulkUpdated);
    };
  }, [contact.id]);

  function acceptPendingRemote() {
    if (!pendingRemote) return;
    setName(pendingRemote.name);
    setFirstName(pendingRemote.firstName);
    setLastName(pendingRemote.lastName);
    setEmail(pendingRemote.email);
    setLocation(pendingRemote.location);
    setLanguage(pendingRemote.language);
    setCountry(pendingRemote.country);
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
    firstName?: string | null;
    lastName?: string | null;
    email?: string | null;
    location?: string | null;
    language?: string | null;
    countryCode?: string | null;
    customFields?: Record<string, string | null>;
  }): Promise<boolean> {
    setError(null);
    // Build the optimistic contact: server-canonical base + current local
    // mirrors (which already reflect any prior committed edits) + this patch.
    // We fan it locally so the sidebar list, the cached thread snapshots,
    // and the thread header stage stepper / contact name all flip instantly
    // instead of waiting on PATCH → bus → socket round-trip.
    const nextCustomFields: Record<string, string> = { ...customFields };
    if (patch.customFields) {
      for (const [k, v] of Object.entries(patch.customFields)) {
        if (v === null) delete nextCustomFields[k];
        else nextCustomFields[k] = v;
      }
    }
    const optimistic = {
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
    };
    // `optimistic: true` skips inbox-list resync + counts refetch during the
    // in-flight PATCH window — see status-dropdown.tsx for the full rationale.
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
      // Roll back the optimistic dispatch.
      dispatchLocalSocketEvent("contact:updated", {
        teamId: contact.teamId,
        contact,
      });
      return false;
    }
    startSaving(() => router.refresh());
    return true;
  }

  /**
   * Assignee picker. POSTs to the same `/conversations/:id/assign` endpoint
   * as the thread header's AssignmentDropdown, so changes from either place
   * write to the same row and the `conversation:assigned` socket echo syncs
   * the other UI surface within a beat.
   */
  async function persistAssignee(nextId: string | null) {
    if (assigneePending) return;
    // Predict the status side-effect via the SHARED predictAssignmentStatus —
    // the same function the thread-header AssignmentDropdown uses, mirroring the
    // server rule (assignment NEVER sets "open"; assign+closed → pending,
    // unassign+open → pending, else unchanged). Driven off `liveStatus` (the
    // panel's local mirror) so a teammate's concurrent close/reopen is already
    // reflected. (This inline ternary previously resurrected the removed
    // "assign → open" rule — single-sourcing it closes that drift for good.)
    const predictedNextStatus = predictAssignmentStatus(liveStatus, nextId);
    const statusWillChange = predictedNextStatus !== liveStatus;
    // Re-picking the CURRENT assignee is a no-op UNLESS it would still flip
    // status (claim an assigned-but-pending chat → open).
    if (nextId === assigneeId && !statusWillChange) return;
    setAssigneePending(true);
    setAssigneeError(null);
    const prevId = assigneeId;
    const prevUser = prevId ? teamMembers.find((u) => u.id === prevId) ?? null : null;
    const nextUser = nextId ? teamMembers.find((u) => u.id === nextId) ?? null : null;
    // Optimistic: paint locally + fan the same socket frames the server
    // will broadcast so every surface flips instantly. Order matches the
    // server publish order: assigned first, then status.
    setAssigneeId(nextId);
    // Bundle every optimistic frame (assigned + activity + maybe status +
    // status-activity) into ONE flushSync so chip + pill commit in a single
    // paint. See status-dropdown.tsx for the full rationale on why splitting
    // into two flushSync calls produces a visible "log lags everything" gap.
    // `optimistic: true` skips inbox-list resync + counts refetch during the
    // in-flight PATCH; the authoritative server frame drives convergence.
    const assignActivity = buildOptimisticAssignment({
      teamId: conversation.teamId,
      conversationId: conversation.id,
      actorName: currentUserName,
      assignedToName: nextUser?.name ?? null,
    });
    const assignActivityId = assignActivity.id;
    let statusActivityId: string | null = null;
    const frames: Parameters<typeof dispatchLocalSocketEvents>[0] = [
      [
        "conversation:assigned",
        {
          teamId: conversation.teamId,
          conversationId: conversation.id,
          assignedUser: nextUser,
          optimistic: true,
        },
      ],
      assignActivity.frame,
    ];
    if (statusWillChange) {
      const statusActivity = buildOptimisticStatusChange({
        teamId: conversation.teamId,
        conversationId: conversation.id,
        actorName: currentUserName,
        status: predictedNextStatus,
      });
      statusActivityId = statusActivity.id;
      frames.push([
        "conversation:status",
        {
          teamId: conversation.teamId,
          conversationId: conversation.id,
          status: predictedNextStatus,
          optimistic: true,
        },
      ]);
      frames.push(statusActivity.frame);
    }
    dispatchLocalSocketEvents(frames);
    const rollbackActivity = () => {
      rollbackOptimisticActivity(conversation.teamId, conversation.id, assignActivityId);
      if (statusActivityId) {
        rollbackOptimisticActivity(conversation.teamId, conversation.id, statusActivityId);
      }
    };
    try {
      const res = await apiFetch(`/api/conversations/${conversation.id}/assign`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assignedUserId: nextId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setAssigneeError(body.error ?? "Couldn't update");
        setAssigneeId(prevId);
        dispatchLocalSocketEvent("conversation:assigned", {
          teamId: conversation.teamId,
          conversationId: conversation.id,
          assignedUser: prevUser,
        });
        if (statusWillChange) {
          dispatchLocalSocketEvent("conversation:status", {
            teamId: conversation.teamId,
            conversationId: conversation.id,
            status: liveStatus,
          });
        }
        rollbackActivity();
        return;
      }
      // No router.refresh(): the optimistic conversation:assigned (+ status)
      // dispatches already flip every live surface, and the server frame
      // converges. A refresh would re-SSR the whole inbox page (now heavy —
      // `?c=<id>` in the URL makes it re-fetch the full open thread).
    } catch (err) {
      setAssigneeError(err instanceof Error ? err.message : "Network error");
      setAssigneeId(prevId);
      dispatchLocalSocketEvent("conversation:assigned", {
        teamId: conversation.teamId,
        conversationId: conversation.id,
        assignedUser: prevUser,
      });
      if (statusWillChange) {
        dispatchLocalSocketEvent("conversation:status", {
          teamId: conversation.teamId,
          conversationId: conversation.id,
          status: liveStatus,
        });
      }
      rollbackActivity();
    } finally {
      setAssigneePending(false);
    }
  }

  // PUT replaces the whole set (server semantics), so we hand it the full
  // next array. Optimistic: paint locally first, rollback on error.
  async function persistTagIds(nextIds: string[]) {
    const prevIds = tagIds;
    setTagIds(nextIds);
    setTagSaveError(null);
    // Bundle the canonical `contact:updated` plus EVERY per-tag activity pill
    // into ONE flushSync. Without batching, a 3-tag swap fired 4 separate
    // flushSyncs (1 contact:updated + 3 activity) → 4 paints in a row, with the
    // sidebar chip painting first and the pills trickling in over the next ~50ms
    // — the visible "log lags everything" gap. See status-dropdown.tsx for
    // background. `optimistic: true` skips the inbox-list resync + counts
    // refetch during the in-flight PUT.
    const tagActivityIds: string[] = [];
    const conversationId = conversation.id;
    const frames: Parameters<typeof dispatchLocalSocketEvents>[0] = [
      [
        "contact:updated",
        {
          teamId: contact.teamId,
          contact: { ...contact, tagIds: nextIds },
          optimistic: true,
        },
      ],
    ];
    {
      const prevSet = new Set(prevIds);
      const nextSet = new Set(nextIds);
      const nameOf = (id: string) => tags.find((t) => t.id === id)?.name ?? null;
      for (const id of nextIds) {
        if (prevSet.has(id)) continue;
        const name = nameOf(id);
        if (name == null) continue;
        const built = buildOptimisticTagAdded({
          teamId: contact.teamId,
          conversationId,
          actorName: currentUserName,
          tagName: name,
        });
        tagActivityIds.push(built.id);
        frames.push(built.frame);
      }
      for (const id of prevIds) {
        if (nextSet.has(id)) continue;
        const name = nameOf(id);
        if (name == null) continue;
        const built = buildOptimisticTagRemoved({
          teamId: contact.teamId,
          conversationId,
          actorName: currentUserName,
          tagName: name,
        });
        tagActivityIds.push(built.id);
        frames.push(built.frame);
      }
    }
    dispatchLocalSocketEvents(frames);
    const res = await apiFetch(`/api/contacts/${contact.id}/tags`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tagIds: nextIds }),
    });
    if (!res.ok) {
      setTagIds(prevIds);
      setTagSaveError("Failed to save tags");
      dispatchLocalSocketEvent("contact:updated", {
        teamId: contact.teamId,
        contact: { ...contact, tagIds: prevIds },
      });
      for (const id of tagActivityIds) {
        rollbackOptimisticActivity(contact.teamId, conversationId, id);
      }
      return;
    }
    // No router.refresh(): the optimistic contact:updated dispatch already
    // reflects the new tag set on every live surface, and the server frame
    // converges. A refresh would re-SSR the whole inbox page (now heavy —
    // `?c=<id>` in the URL makes it re-fetch the full open thread).
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
    <aside
      className="hidden h-full shrink-0 flex-col overflow-hidden border-l border-border bg-sidebar text-sidebar-foreground lg:flex"
      style={{
        width: collapsed ? 48 : 320,
        transition: transitionEnabled
          ? "width 250ms cubic-bezier(0.4, 0, 0.2, 1)"
          : "none",
      }}
    >
      {collapsed && (
        // Collapsed rail: a single expand button filling the thin rail.
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={toggleCollapsed}
              className="flex h-11 w-12 shrink-0 items-center justify-center border-b border-border text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
              aria-label="Expand contact panel"
            >
              <ChevronLeft className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="left">Contact details</TooltipContent>
        </Tooltip>
      )}
      {/* Expanded body. Fixed 320px inner width + shrink-0 so the dense content
          never reflows/squashes while the aside animates its width — it stays
          full-width and the shrinking aside (overflow-hidden) clips it from the
          right, a clean slide-out. Unmounted when collapsed so it can't stack
          under the rail button in the 48px column. */}
      {!collapsed && (
      <div className="flex h-full w-[320px] shrink-0 flex-col">
      {/* Header bar with the collapse toggle, at the panel's right edge. */}
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border pl-4 pr-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Details
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={toggleCollapsed}
              className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
              aria-label="Collapse contact panel"
            >
              <PanelRightClose className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="left">Collapse panel</TooltipContent>
        </Tooltip>
      </div>
      {/* View tabs (Details / Files). Sits between the header strip and the
          panel body. Tiny segmented control to match the panel's density. */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-2">
        <button
          type="button"
          onClick={() => setView("details")}
          className={cn(
            "flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors",
            view === "details"
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
          )}
        >
          Details
        </button>
        <button
          type="button"
          onClick={() => setView("files")}
          className={cn(
            "flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors",
            view === "files"
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
          )}
        >
          <Paperclip className="size-3.5" />
          Files
        </button>
      </div>
      {pendingRemote && view === "details" ? (
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
      {view === "files" ? (
        <ScrollArea className="flex-1">
          <AttachmentGallery
            conversationId={conversation.id}
            onGoToMessage={onGoToMessage}
          />
        </ScrollArea>
      ) : (
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
          {/* Phone is always shown — WhatsApp identity, not hideable. */}
          <ReadOnlyRow
            icon={Phone}
            label="Phone"
            mono
            value={formatPhone(contact.phoneNumber)}
          />
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
          {builtins.firstContacted && (
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
          )}

          {/* Team-wide fields. Rendered in their definition order; admin-hidden
              definitions are dropped at this level so they never paint. */}
          {fieldDefinitions.filter((def) => def.isVisible).map((def) => (
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

        <Section title="Assignee">
          <AssigneePicker
            teamId={conversation.teamId}
            currentId={assigneeId}
            // ACTIVE members for the dropdown — assigning a NEW conversation
            // to a deactivated agent has no defensible UX. The picker
            // resolves the CURRENT id's label from this same list, so
            // splice the current assignee back in even if they're
            // deactivated (otherwise the picker shows "no assignee" until
            // the operator picks someone else, which is misleading — the
            // thread IS still assigned). Pre-existing UX gap from the
            // 2026-05-26 cross-cutting audit (D6).
            teamMembers={(() => {
              const active = teamMembers.filter((u) => u.isActive);
              if (assigneeId && !active.some((u) => u.id === assigneeId)) {
                const current = teamMembers.find((u) => u.id === assigneeId);
                if (current) return [current, ...active];
              }
              return active;
            })()}
            pending={assigneePending}
            onChange={(next) => void persistAssignee(next)}
          />
          {assigneeError && (
            <div className="mt-2 text-[11px] text-destructive">
              {assigneeError}
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
      )}
      </div>
      )}
    </aside>
  );
}

/**
 * React.memo wrapper with a custom equality function. Without memo this
 * panel re-rendered on every `message:new` / `message:status` / etc. —
 * the parent passes a fresh `data: ConversationWithRefs` reference on
 * every reducer write. The panel only cares about contact + notes +
 * conversation header (assignedUserId / status / unreadCount), so a
 * per-field shallow check skips renders triggered by message-only state
 * changes. At 10 inbound/sec on a hot pilot, that's 10 wasted full
 * renders/sec of the right rail (custom fields, attachments tab, tags).
 *
 * `messages` is omitted from the equality check ON PURPOSE — the panel
 * uses `messages.length` for the "Messages" tally, which falls out of
 * `data.messageCount` (which IS in the check). The Attachments tab
 * runs its own `useConversationAttachments` hook that re-fetches on
 * message:new + message:media:ready independently of this prop, so
 * shallow message-array changes don't need to invalidate the panel.
 */
export const ContactPanel = memo(ContactPanelImpl, (prev, next) => {
  if (prev.initialCollapsed !== next.initialCollapsed) return false;
  if (prev.canManageFields !== next.canManageFields) return false;
  if (prev.currentUserName !== next.currentUserName) return false;
  if (prev.onGoToMessage !== next.onGoToMessage) return false;
  if (prev.builtins !== next.builtins) return false;
  if (prev.fieldDefinitions !== next.fieldDefinitions) return false;
  if (prev.tagCatalog !== next.tagCatalog) return false;
  if (prev.teamMembers !== next.teamMembers) return false;
  const a = prev.data;
  const b = next.data;
  if (a === b) return true;
  // Contact (the bulk of what the panel renders).
  if (a.contact !== b.contact) {
    // Shallow check the fields the panel actually reads.
    const ac = a.contact;
    const bc = b.contact;
    if (
      ac.id !== bc.id ||
      ac.phoneNumber !== bc.phoneNumber ||
      ac.name !== bc.name ||
      ac.email !== bc.email ||
      ac.stageId !== bc.stageId ||
      ac.firstName !== bc.firstName ||
      ac.lastName !== bc.lastName ||
      ac.countryCode !== bc.countryCode ||
      ac.language !== bc.language ||
      ac.avatarUrl !== bc.avatarUrl ||
      !arraysEqual(ac.tagIds ?? [], bc.tagIds ?? []) ||
      !shallowJsonEqual(ac.customFields ?? {}, bc.customFields ?? {})
    ) {
      return false;
    }
  }
  // Conversation header bits the panel renders (status pill, assignee, unread).
  if (
    a.conversation.status !== b.conversation.status ||
    a.conversation.assignedUserId !== b.conversation.assignedUserId ||
    a.conversation.unreadCount !== b.conversation.unreadCount
  ) {
    return false;
  }
  if ((a.assignedUser?.id ?? null) !== (b.assignedUser?.id ?? null)) return false;
  if (a.lastInboundAt !== b.lastInboundAt) return false;
  // Notes — reference compare is fine; the notes array is replaced wholesale
  // on add/delete by the live reducer.
  if (a.notes !== b.notes) return false;
  if (a.messageCount !== b.messageCount) return false;
  return true;
});

/**
 * Sidebar assignee picker. Mirrors the conversation header's
 * `AssignmentDropdown` shape and writes to the same `Conversation.assignedUserId`
 * — the two pickers are intentionally the same control rendered in two places
 * so changes in one reflect in the other via the `conversation:assigned`
 * socket echo.
 */
function AssigneePicker({
  teamId,
  currentId,
  teamMembers,
  pending,
  onChange,
}: {
  teamId: string;
  currentId: string | null;
  teamMembers: User[];
  pending: boolean;
  onChange: (next: string | null) => void;
}) {
  const current = currentId ? teamMembers.find((u) => u.id === currentId) ?? null : null;
  // Subscribe to the team's online + availability state inline. usePresence is
  // cheap (shared socket; two listeners) and only this picker reads the
  // result, so threading availabilityByUserId through ContactPanel for one
  // dropdown isn't worth the prop-drilling.
  const { onlineUserIds, availabilityByUserId } = usePresence(teamId, "");
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
              <Avatar className="size-5">
                {current.avatarUrl ? (
                  <AvatarImage src={current.avatarUrl} alt={current.name} />
                ) : null}
                <AvatarFallback seed={current.id} className="text-[10px]">{initials(current.name)}</AvatarFallback>
              </Avatar>
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
      <DropdownMenuContent
        align="start"
        className="w-56"
        // Suppress Radix focus-return so the trigger doesn't keep the
        // `:focus-visible` ring after a mouse pick. See status-dropdown.tsx
        // for the full rationale.
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <DropdownMenuLabel>Assigned agent</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onChange(null)}>
          {currentId === null && <Check className="size-3.5" />}
          <span className={cn("text-muted-foreground", currentId === null && "ml-1")}>
            Unassigned
          </span>
        </DropdownMenuItem>
        {teamMembers.map((u) => {
          const online = onlineUserIds.has(u.id);
          const availability = availabilityByUserId[u.id];
          const dotClass = online
            ? (availability
                ? AVAILABILITY_DOT_CLASSES[availability.status]
                : AVAILABILITY_DOT_CLASSES.available)
            : AVAILABILITY_DOT_CLASSES.offline;
          const cue = !online
            ? "Offline"
            : availability && availability.status !== "available"
              ? AVAILABILITY_LABELS[availability.status]
              : null;
          return (
            <DropdownMenuItem
              key={u.id}
              onSelect={() => onChange(u.id)}
              title={availability?.message ?? undefined}
            >
              {currentId === u.id ? (
                <Check className="size-3.5" />
              ) : (
                <div className="relative">
                  <Avatar className="size-5">
                    {u.avatarUrl ? <AvatarImage src={u.avatarUrl} alt={u.name} /> : null}
                    <AvatarFallback seed={u.id} className="text-[10px]">{initials(u.name)}</AvatarFallback>
                  </Avatar>
                  <span
                    className={cn(
                      "absolute -bottom-0.5 -right-0.5 size-1.5 rounded-full ring-1 ring-popover",
                      dotClass,
                    )}
                    aria-hidden
                  />
                </div>
              )}
              <span className="flex-1 truncate">{u.name}</span>
              {cue && (
                <span className="shrink-0 text-[10px] text-muted-foreground">{cue}</span>
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
