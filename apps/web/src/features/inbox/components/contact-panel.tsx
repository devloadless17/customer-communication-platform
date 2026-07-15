"use client";

import { memo, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useSoftRefresh } from "@/hooks/use-soft-refresh";
import { useNow } from "@/hooks/use-now";
import { AtSign, BadgeCheck, ChevronLeft, Mail, Paperclip, Phone, MapPin, Clock, FileText, Heart, Loader2, MessageSquare, PanelRightClose, RefreshCw, Sparkles, User as UserIcon, Globe, Flag, Users } from "lucide-react";

import {
  AddFieldRow,
  prettifyKey,
  uniquePerContactKey,
} from "@/features/contacts/components/field-controls";
import { TagChip, TagAddButton } from "@/features/tags/components/tag-chip";
import { TagMultiPicker } from "@/features/tags/components/tag-multi-picker";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  buildOptimisticTagAdded,
  buildOptimisticTagRemoved,
  rollbackOptimisticActivity,
} from "@/features/inbox/lib/optimistic-activity";
import { toast } from "@/lib/toast";
import { assertReducerCoverage } from "@/features/inbox/lib/thread-reducers";
import { usePanelResize } from "@/features/inbox/hooks/use-panel-resize";
import { INBOX_DETAILS_WIDTH_COOKIE } from "@/features/inbox/lib/panel-cookies";
import { emitOpenTemplatePicker } from "@/features/inbox/lib/open-template-picker";
import { CHANNEL_LABEL } from "./channel-badge";
import { CHANNEL_CAPABILITIES } from "@ccp/shared/providers/capabilities";
import { LinkedChannels } from "./linked-channels";
import { cn, formatPhone, initials } from "@ccp/shared/utils";
import type {
  ContactFieldDefinition,
  ContactPanelBuiltins,
  ConversationWithRefs,
  InternalNote,
  SocialProfile,
  Tag,
  User,
} from "@ccp/shared/types";

import { AttachmentGallery } from "./attachments/attachment-gallery";
import { EditableField } from "./contact-panel/editable-field";
import { EditableHeading } from "./contact-panel/editable-heading";
import { ReadOnlyRow } from "./contact-panel/read-only-row";
import { Section } from "./contact-panel/section";
import { AiConversationPanel } from "./ai/ai-conversation-panel";

/** True when a social profile carries at least one signal worth rendering. */
function hasSocialSignals(p: SocialProfile): boolean {
  return (
    p.isVerified === true ||
    typeof p.followerCount === "number" ||
    p.followsBusiness === true ||
    p.businessFollows === true
  );
}

/** Compact follower count — 1.2k / 3.4M, like every social app. */
function formatFollowerCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Inline row of Instagram profile signals (verified · followers · follow-back).
 *  Rendered as the value of the "Instagram" ReadOnlyRow. */
function SocialSignals({ profile }: { profile: SocialProfile }) {
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
      {profile.isVerified && (
        <span className="inline-flex items-center gap-0.5 text-sky-600 dark:text-sky-400">
          <BadgeCheck className="size-3.5" />
          Verified
        </span>
      )}
      {typeof profile.followerCount === "number" && (
        <span className="inline-flex items-center gap-0.5">
          <Users className="size-3.5 text-muted-foreground" />
          {formatFollowerCount(profile.followerCount)} followers
        </span>
      )}
      {/* Follow relationship — two independent directions, each its own row with
          the SAME filled heart (a filled-vs-outline mix read as inconsistent). */}
      {profile.followsBusiness && (
        <span className="inline-flex items-center gap-0.5 text-muted-foreground">
          <Heart className="size-3.5 fill-current" />
          Follows you
        </span>
      )}
      {profile.businessFollows && (
        <span className="inline-flex items-center gap-0.5 text-muted-foreground">
          <Heart className="size-3.5 fill-current" />
          You follow them
        </span>
      )}
    </span>
  );
}

/** True when a social profile carries at least one Messenger-provided signal. */
function hasMessengerSignals(p: SocialProfile): boolean {
  return (
    (typeof p.gender === "string" && p.gender.trim() !== "") ||
    (typeof p.locale === "string" && p.locale.trim() !== "") ||
    typeof p.timezone === "number"
  );
}

/** Meta locale (`en_US`) → readable language name ("English"); raw locale on
 *  fallback. Mirrors the server-side helper in providers/ingest.ts. */
function languageNameFromLocale(locale: string): string {
  const lang = locale.split(/[_-]/)[0]?.trim().toLowerCase();
  if (!lang) return locale;
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(lang) ?? locale;
  } catch {
    return locale;
  }
}

/** Stacked list of Messenger profile details (gender · language · local time),
 *  rendered as the value of the single "Messenger" ReadOnlyRow — the Messenger
 *  analogue of {@link SocialSignals} for Instagram. */
function MessengerSignals({ profile }: { profile: SocialProfile }) {
  return (
    <span className="flex flex-col gap-y-0.5">
      {profile.gender && (
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <UserIcon className="size-3.5" />
          {profile.gender.charAt(0).toUpperCase() + profile.gender.slice(1)}
        </span>
      )}
      {profile.locale && (
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <Globe className="size-3.5" />
          {languageNameFromLocale(profile.locale)}
        </span>
      )}
      {typeof profile.timezone === "number" && (
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <Clock className="size-3.5" />
          <ContactLocalTime offsetHours={profile.timezone} />
        </span>
      )}
    </span>
  );
}

/**
 * The customer's current LOCAL time, derived from Meta's `timezone` GMT offset
 * (Messenger). Live — ticks each minute via `useNow()` — so it stays honest
 * without a reload, exactly like the "Local time" row in Meta's own inbox.
 * Shift epoch into the contact's offset, then read the UTC parts = their wall
 * clock (works for fractional offsets like +5.5).
 */
function ContactLocalTime({ offsetHours }: { offsetHours: number }) {
  const now = useNow();
  const d = new Date(now + offsetHours * 3_600_000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const gmt = `GMT${offsetHours >= 0 ? "+" : "−"}${Math.abs(offsetHours)}`;
  return (
    <span title={gmt}>
      {hh}:{mm}
      <span className="ml-1 text-muted-foreground">· {gmt}</span>
    </span>
  );
}

/**
 * Shape of every editable contact field tracked by the panel. Used to type
 * `editableRef`, `serverSnapshotRef`, and `pendingRemote` so adding a new
 * editable field fails at the type checker if any one of those sync points is
 * missed. See the comment over `editableRef` for the full sync-point list.
 */
type EditableState = {
  name: string;
  firstName: string;
  lastName: string;
  email: string;
  location: string;
  language: string;
  country: string;
  customFields: Record<string, string>;
  tagIds: string[];
};

/** Shallow string-record equality used to compare customField maps. */
function shallowJsonEqual(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
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
  /** Team roster — forwarded to the Files tab's attachment gallery for
   *  per-message author avatars. */
  teamMembers: User[];
  /** Current agent's display name — actor on optimistic activity pills
   *  (stage / tag changes made from this panel). */
  currentUserName: string;
  /** Server-read cookie so the panel SSRs in its persisted rail state (no
   *  expand→collapse flash). Default false (expanded). */
  initialCollapsed: boolean;
  /** SSR-read persisted panel width (cookie) — seeds the drag-resize so the
   *  rail paints at its saved width on first render (no post-refresh jump). */
  initialDetailsWidth: number | null;
  /** Jump the thread to a specific message (id) — used by the Files tab so
   *  clicking "Jump" on an attachment scrolls + flashes the source bubble.
   *  Reuses the same `jumpTarget` state inbox-shell already drives for
   *  global search results. */
  onGoToMessage: (messageId: string) => void;
  /**
   * Layout container. `"aside"` (default) = the desktop `lg:`-only right rail
   * with collapse-to-rail. `"sheet"` = render the body full-width with no
   * `<aside>` chrome + no collapse toggle, for the mobile/tablet Sheet (the
   * Sheet supplies its own container + close button). Below `lg` the desktop
   * aside is hidden, so the Sheet is the ONLY way to reach contact details
   * (tags, stage, custom fields, files) on a phone.
   */
  variant?: "aside" | "sheet";
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
  initialDetailsWidth,
  onGoToMessage,
  variant = "aside",
}: PanelProps) {
  const isSheet = variant === "sheet";
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
    } else {
      // No explicit preference yet: default COLLAPSED below the xl breakpoint
      // (1280px). On a 1024–1279px laptop an expanded panel forces the list +
      // thread to their min-width floors (the "density cliff"); a fresh user
      // there gets the calm rail instead. Expand still works + persists. The
      // transition is still gated off on first mount, so this paints at the
      // right width without an animated open→close.
      setCollapsed(window.matchMedia("(max-width: 1279px)").matches);
    }
    const raf = requestAnimationFrame(() => setTransitionEnabled(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // Keep the no-preference default in sync when the window crosses the xl
  // boundary (e.g. a laptop user docks/undocks an external monitor). Once the
  // user has explicitly toggled (cookie present), their choice wins and this
  // no-ops.
  useEffect(() => {
    const mql = window.matchMedia("(max-width: 1279px)");
    function onChange() {
      const hasPref = document.cookie.includes("contact-panel-collapsed=");
      if (!hasPref) setCollapsed(mql.matches);
    }
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    // Cookie (not localStorage) so the server layout reads it and SSRs the
    // correct width next load — that's what kills the flash. Default expanded,
    // so only an explicit "true" persists the collapsed rail.
    document.cookie = `contact-panel-collapsed=${String(next)}; path=/; max-age=31536000; samesite=lax`;
  }

  // Drag-to-resize the expanded panel. Handle sits on the panel's LEFT edge so
  // dragging left widens it (grow: "left"). Persisted width; null until mount
  // (falls back to 320 = the prior fixed width, so no hydration mismatch).
  const {
    width: detailsWidth,
    dragging: resizing,
    onHandleDown,
    onHandleKeyDown,
  } = usePanelResize({
    storageKey: INBOX_DETAILS_WIDTH_COOKIE,
    initial: initialDetailsWidth,
    min: 260,
    max: 520,
    def: 320,
    grow: "left",
    // Don't let dragging the details panel so wide that the messages column
    // (its sibling in the body row) drops below a usable thread width. Measured
    // live from the handle's parent (the body row = messages + handle + panel).
    getDragMax: (handle) => {
      const row = handle.parentElement;
      if (!row) return Infinity;
      const MIN_THREAD = 560; // keep in sync with inbox-shell MIN_THREAD_WIDTH
      return row.getBoundingClientRect().width - 4 /* handle */ - MIN_THREAD;
    },
  });
  const expandedWidth = detailsWidth ?? 320;

  // ------------------------------------------------------------------
  // Live stats. ContactPanel is rendered in MessageThread's `rightPanel`
  // slot (see inbox-shell ThreadWorkspace) but is NOT driven by its state —
  // it receives the same frozen server-rendered `data` snapshot the thread
  // got, and only MessageThread runs useConversationEvents, so this `data`
  // prop stays frozen on this side. We mirror the small slice the panel
  // renders (status + counts) by subscribing to the same events here. Two
  // listeners for the same
  // events is cheap; the alternative would be lifting the hook into
  // a shared parent, which is a much larger refactor for this one
  // panel.
  // ------------------------------------------------------------------
  const [liveNoteCount, setLiveNoteCount] = useState<number>(
    data.noteCount ?? notes.length,
  );
  // Live notes ARRAY for the gallery (AttachmentGallery "Notes" tab). The
  // `notes` prop is the inbox-shell LRU snapshot (frozen while the thread is
  // displayed — note:new isn't wired into the silent snapshot patch), so
  // without this the gallery only shows a newly-created note after a refresh /
  // chat-switch. Mirrors the liveStatus/liveNoteCount direct-subscription
  // pattern above. Re-seeded from the prop on switch/refetch (effect below).
  const [liveNotes, setLiveNotes] = useState<InternalNote[]>(notes);
  // Dedupe live tally bumps by id. message:new / note:* frames REPLAY on
  // Socket.io connection-state-recovery (and any transient duplicate), and an
  // un-guarded `n + 1` would over-count the panel's "Messages"/"Notes" totals
  // until the next thread switch. Seen-sets make each frame idempotent; reset
  // on conversation switch (below) so they don't grow across threads.
  const seenNoteAddRef = useRef<Set<string>>(new Set());
  const seenNoteDelRef = useRef<Set<string>>(new Set());

  // Reset whenever the user switches to a different conversation OR the
  // server snapshot changes (router.refresh after a mutation). Without
  // this the panel would keep showing the previous thread's counts when
  // the prop changes.
  useEffect(() => {
    setLiveNoteCount(data.noteCount ?? notes.length);
    seenNoteAddRef.current = new Set();
    seenNoteDelRef.current = new Set();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.id, data.noteCount]);

  // Re-seed the live notes array from the authoritative prop whenever it
  // changes identity (conversation switch or a refetch/router.refresh) — the
  // snapshot is referentially stable while displayed, so this doesn't clobber
  // live-appended notes mid-thread.
  useEffect(() => {
    setLiveNotes(notes);
  }, [notes]);

  useEffect(() => {
    const socket = getClientSocket();
    const conversationId = conversation.id;

    // Dev-only invariant: ContactPanel is the 3rd thread-state consumer (see
    // thread-reducers.ts header). It derives liveStatus / liveMessageCount /
    // liveNoteCount DIRECTLY from these 4 events because its `data` prop is the
    // inbox-shell LRU snapshot (frozen w.r.t. live status/counts while the
    // thread is displayed), not MessageThread's live hook. Asserting coverage
    // here means a future field derived from an un-covered event fails loudly in
    // dev instead of silently diverging. All 4 are covered today (no-op).
    assertReducerCoverage(["note:new", "note:deleted"]);

    const onNoteNew: Parameters<typeof socket.on<"note:new">>[1] = (payload) => {
      if (payload.conversationId !== conversationId) return;
      if (seenNoteAddRef.current.has(payload.note.id)) return;
      seenNoteAddRef.current.add(payload.note.id);
      setLiveNoteCount((n) => n + 1);
      // Append to the gallery array too (guard against a racing duplicate that
      // slipped the seen-set, e.g. optimistic + server frame).
      setLiveNotes((prev) =>
        prev.some((n) => n.id === payload.note.id) ? prev : [...prev, payload.note],
      );
    };
    const onNoteDeleted: Parameters<typeof socket.on<"note:deleted">>[1] = (
      payload,
    ) => {
      if (payload.conversationId !== conversationId) return;
      if (seenNoteDelRef.current.has(payload.noteId)) return;
      seenNoteDelRef.current.add(payload.noteId);
      setLiveNoteCount((n) => Math.max(0, n - 1));
      setLiveNotes((prev) => prev.filter((n) => n.id !== payload.noteId));
    };

    socket.on("note:new", onNoteNew);
    socket.on("note:deleted", onNoteDeleted);

    return () => {
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
  // The conversation's channel drives the header identity line + channel badge
  // (phone for WhatsApp; the channel label for non-phone Messenger/Instagram).
  const panelChannel = conversation.channel ?? "whatsapp";
  // Local mirror of the team catalog so newly-created tags appear immediately
  // without waiting for a router.refresh round-trip.
  const [tags, setTags] = useState<Tag[]>(tagCatalog);
  const [tagPickerOpen, setTagPickerOpen] = useState(false);
  const tagBoxRef = useRef<HTMLDivElement>(null);

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
    setTagPickerOpen(false);
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
  const serverSnapshotRef = useRef<EditableState>({
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
  //
  // EditableState explicitly enumerates every editable field so adding a
  // new one is a type error at the binding sites below — without the
  // explicit type, a forgotten field silently slips out of the dirty-check
  // and the conflict-detection effect. Sync points to update together when
  // extending: this ref, serverSnapshotRef, both dirty checks in the
  // contact:updated / contacts:bulk_updated handlers, pendingRemote state,
  // and the re-sync useEffect on contact.id change.
  const editableRef = useRef<EditableState>({
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
  const [pendingRemote, setPendingRemote] = useState<EditableState | null>(null);

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
  const [syncing, setSyncing] = useState(false);

  // Social channels expose a richer profile on Meta than the inbound webhook
  // carries; this pulls it on demand (name / @username / avatar / follower +
  // verified signals). Capability-driven so a future channel opts in explicitly
  // rather than being inferred from "not WhatsApp" (which would wrongly show the
  // button for SMS / Email / Telegram once they ship).
  const canSyncProfile = CHANNEL_CAPABILITIES[panelChannel]?.profileSync ?? false;
  async function syncProfile() {
    if (syncing) return;
    setSyncing(true);
    try {
      const res = await apiFetch(`/api/contacts/${contact.id}/sync-profile`, {
        method: "POST",
      });
      // The server publishes contact.updated, so the panel refreshes over the
      // socket — no local state merge needed. Just surface the outcome.
      toast[res.ok ? "success" : "error"](
        res.ok ? "Profile synced" : "Couldn't sync profile",
      );
    } catch {
      toast.error("Couldn't sync profile");
    } finally {
      setSyncing(false);
    }
  }

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
      // Surface via toast, not a silent inline whisper — a field save that
      // fails after the optimistic paint reverts otherwise looks like a glitch
      // (the value flickers back with no explanation). Toast is visible,
      // auto-dismissing, and consistent with the stage/tag failure path.
      toast.error("Couldn't save contact", {
        description: body.error ?? "Please try again.",
      });
      // Roll back to the state the app believed BEFORE this patch: keep the
      // current local mirrors (which carry any prior committed-but-not-yet-
      // refreshed edits — the same base the optimistic build above uses) and
      // revert ONLY this patch's fields to the server-canonical `contact`.
      // Dispatching the raw `contact` (the old behavior) also reverted those
      // earlier successful edits in the sidebar list + cached snapshots until
      // the next refresh, so the list briefly disagreed with the panel.
      const rollback = {
        ...contact,
        name: "name" in patch ? contact.name : name,
        firstName:
          "firstName" in patch ? contact.firstName ?? null : firstName || null,
        lastName:
          "lastName" in patch ? contact.lastName ?? null : lastName || null,
        email: "email" in patch ? contact.email ?? undefined : email || undefined,
        location:
          "location" in patch
            ? contact.location ?? undefined
            : location || undefined,
        language: "language" in patch ? contact.language ?? null : language || null,
        countryCode:
          "countryCode" in patch ? contact.countryCode ?? null : country || null,
        customFields:
          "customFields" in patch ? contact.customFields : nextCustomFields,
        tagIds,
      };
      dispatchLocalSocketEvent("contact:updated", {
        teamId: contact.teamId,
        contact: rollback,
      });
      return false;
    }
    // No router.refresh(): the optimistic `contact:updated` dispatch above plus
    // the server's authoritative `contact.updated` socket frame already
    // converge every consumer (same as persistTagIds). Re-SSRing the whole
    // inbox page (with ?c=<id>, which refetches the full open thread) on every
    // field edit was pure waste. router.refresh stays only in onAddTeamWide,
    // where SSR must genuinely re-run to load a new team-wide field definition.
    return true;
  }

  // PUT replaces the whole set (server semantics), so we hand it the full
  // next array. Optimistic: paint locally first, rollback on error.
  async function persistTagIds(nextIds: string[]) {
    const prevIds = tagIds;
    setTagIds(nextIds);
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
      // Toast, not the old text-3xs inline whisper (no dismiss, easy to miss as
      // a glitch when the chip silently reverts). Consistent with field/stage.
      toast.error("Couldn't save tags", { description: "Please try again." });
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

  // In the mobile Sheet the panel is always expanded full-width (the Sheet is
  // the container) — the desktop collapse-to-rail doesn't apply.
  const effectiveCollapsed = isSheet ? false : collapsed;

  // Inner body — identical in both variants. Wrapped by either the desktop
  // `<aside>` (with collapse rail) or, on mobile, a plain full-width flex div
  // inside the Sheet.
  const body = (
      <div
        className={cn(
          "flex h-full shrink-0 flex-col",
          isSheet && "w-full",
        )}
        // Desktop: fill the panel's CURRENT (resized) width so dragging the rail
        // wider/narrower leaves no dead gutter and clips nothing — shrink-0 still
        // keeps the content from squashing while the aside animates open/closed.
        // Sheet: the w-full class above owns the width.
        style={isSheet ? undefined : { width: expandedWidth }}
      >
      {/* Header bar. Desktop: collapse toggle at the right edge. Sheet: just
          the "Details" label (the Sheet renders its own close X; the `pr-11`
          keeps the label clear of it). */}
      {isSheet ? (
        <div className="flex h-11 shrink-0 items-center border-b border-border pl-4 pr-11">
          <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
            Details
          </span>
        </div>
      ) : (
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border pl-4 pr-1.5">
        <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
          Details
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={toggleCollapsed}
              className="flex size-8 pointer-coarse:size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              aria-label="Collapse contact panel"
            >
              <PanelRightClose className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="left">Collapse panel</TooltipContent>
        </Tooltip>
      </div>
      )}
      {/* View tabs (Details / Files). Sits between the header strip and the
          panel body. Tiny segmented control to match the panel's density. */}
      <div
        role="tablist"
        aria-label="Contact panel view"
        className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-2"
      >
        <button
          type="button"
          role="tab"
          aria-selected={view === "details"}
          onClick={() => setView("details")}
          className={cn(
            "flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors",
            view === "details"
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
          )}
        >
          Details
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "files"}
          onClick={() => setView("files")}
          className={cn(
            "flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors",
            view === "files"
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
          )}
        >
          <Paperclip className="size-3.5" />
          Files
        </button>
      </div>
      {pendingRemote && view === "details" ? (
        <div className="flex items-start gap-2 border-b border-warning-border bg-warning-bg px-4 py-2 text-xs text-warning-fg">
          <span className="mt-px inline-block size-1.5 shrink-0 rounded-full bg-warning-fg" />
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
                className="rounded-md bg-warning-fg px-2 py-0.5 text-2xs font-medium text-white hover:opacity-90"
              >
                Reload
              </button>
              <button
                type="button"
                onClick={dismissPendingRemote}
                className="rounded-md border border-warning-border px-2 py-0.5 text-2xs font-medium text-warning-fg hover:bg-warning-bg"
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
            notes={liveNotes}
            teamMembers={teamMembers}
          />
        </ScrollArea>
      ) : (
      <ScrollArea className="flex-1">
        {/* Attio-style header: avatar + name share one left axis with the value
            rows below, so the eye scans a single column edge (was a centered
            block over left-aligned rows). */}
        <div className="flex items-center gap-3 px-5 pt-5 pb-3">
          <Avatar className="size-11 shrink-0">
            {contact.avatarUrl ? (
              <AvatarImage src={contact.avatarUrl} alt="" />
            ) : null}
            <AvatarFallback
              className="text-base text-white"
              style={{ backgroundImage: avatarGradient(contact.id) }}
            >
              {initials(name || contact.name)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
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
              {contact.phoneNumber
                ? formatPhone(contact.phoneNumber)
                : CHANNEL_LABEL[panelChannel]}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5 px-5 pb-4">
          <Badge variant="muted">{CHANNEL_LABEL[panelChannel]}</Badge>
          {/* Distinguishes contacts an agent created (e.g. via the New
              Contact dialog or CSV import) from contacts we got because a
              customer messaged us. The list page filters by this too. Kept
              MUTED (provenance, not status) — the removed always-green
              "Active" badge was hardcoded and contradicted closed chats; live
              status is shown in the Status row below. */}
          <Badge variant="muted">
            {contact.source === "manual" ? "Added by you" : "Messaged you"}
          </Badge>
        </div>

        {/* Start a conversation with an approved template — the WhatsApp re-
            engagement path when the 24h free-form window is closed (templates are
            WhatsApp-only, so this is hidden on Messenger/Instagram). Opens the
            composer's existing template picker for this thread via a signal, so
            the full load/variable-fill/send flow isn't duplicated here. */}
        {CHANNEL_CAPABILITIES[panelChannel]?.templates && (
          <div className="px-5 pb-4">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 w-full gap-1.5 text-xs"
              onClick={() => emitOpenTemplatePicker(conversation.id)}
            >
              <Sparkles className="size-3.5" />
              Send template
            </Button>
          </div>
        )}

        {/* Unified customer: the same person's other channel-contacts + link/split. */}
        <div className="border-t">
          <LinkedChannels contactId={contact.id} />
        </div>

        <Section
          title="Contact info"
          right={
            <div className="flex items-center gap-1.5">
              {saving && (
                <Loader2 className="size-3 animate-spin text-muted-foreground" />
              )}
              {canSyncProfile && (
                <button
                  type="button"
                  onClick={syncProfile}
                  disabled={syncing}
                  title={`Refresh profile from ${CHANNEL_LABEL[panelChannel]}`}
                  aria-label={`Refresh profile from ${CHANNEL_LABEL[panelChannel]}`}
                  className="inline-flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                >
                  <RefreshCw className={cn("size-3", syncing && "animate-spin")} />
                </button>
              )}
            </div>
          }
        >
          {/* Phone is read-only: on phone channels (WhatsApp) it's the identity
              used to dedupe inbound webhooks and route conversations. Editing it
              would break the link to the customer's account, so it's not
              editable. Non-phone channels (Messenger/Instagram) have no phone —
              their identity is the opaque provider id, shown as the channel
              label above, so the Phone row is omitted. */}
          {contact.phoneNumber && (
            <ReadOnlyRow
              icon={Phone}
              label="Phone"
              mono
              value={formatPhone(contact.phoneNumber)}
            />
          )}
          {/* Instagram @username — the one extra identifier Meta exposes for a
              social contact (Messenger/WhatsApp have none). Read-only; it's the
              provider handle, not something the agent sets. */}
          {contact.username && (
            <ReadOnlyRow
              icon={AtSign}
              label="Username"
              mono
              value={`@${contact.username}`}
            />
          )}
          {/* Instagram profile signals (verified / followers / follow-back) —
              display-only context, rendered only when Meta returned them. */}
          {contact.socialProfile && hasSocialSignals(contact.socialProfile) && (
            <ReadOnlyRow
              icon={BadgeCheck}
              label="Instagram"
              value={<SocialSignals profile={contact.socialProfile} />}
            />
          )}
          {/* Messenger profile details grouped under ONE "Messenger" row —
              gender · language (from `locale`) · local time (from `timezone`) —
              the Messenger analogue of the "Instagram" row above. Each field is
              behind a `pages_user_*` App Review perm, so the row shows only the
              signals Meta actually returned, and hides entirely when there are
              none. */}
          {contact.socialProfile && hasMessengerSignals(contact.socialProfile) && (
            <ReadOnlyRow
              icon={MessageSquare}
              label="Messenger"
              value={<MessengerSignals profile={contact.socialProfile} />}
            />
          )}
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
              // Make the email actionable — opens the agent's mail client.
              // Phone deliberately gets no tel: link (it's the WhatsApp
              // identity, not a phone-to-dial number).
              actionHref={email ? `mailto:${email.trim()}` : undefined}
              actionLabel={`Email ${email.trim()}`}
              ActionIcon={Mail}
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
                // Authoritative: the contact row is created on first inbound, so
                // its createdAt IS "first contacted" — independent of how much of
                // the thread is paged in. messages[0] is only the oldest LOADED
                // message, which on a long thread is mid-history (wrong date).
                contact.createdAt ? (
                  <LocalTime iso={contact.createdAt} format="shortDate" />
                ) : messages[0] ? (
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
            <div className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-2xs text-destructive">
              {error}
            </div>
          )}
        </Section>

        {/* Assignee + Stage are NOT rendered here on purpose — both controls
            live in the thread header (AssignmentDropdown + ContactStagePicker),
            so duplicating them in this rail was redundant. The contacts-page
            ContactDetailDrawer still owns the stage UI for off-inbox editing. */}

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
        </Section>

        {/* Native AI Assistant: person-level memory, then the current session
            summary. Two distinct surfaces (never merged). */}
        <AiConversationPanel conversationId={conversation.id} />

        {/* Status is already shown in the thread header, and a raw message count
            isn't actionable — so this section now surfaces ONLY the internal-note
            tally, and only when there are notes, as a "you have notes here" cue. */}
        {liveNoteCount > 0 && (
          <Section title="Conversation">
            <ReadOnlyRow
              icon={FileText}
              label="Notes"
              value={`${liveNoteCount} internal note${liveNoteCount === 1 ? "" : "s"}`}
            />
          </Section>
        )}

      </ScrollArea>
      )}
      </div>
  );

  // Sheet variant: no `<aside>` chrome, no collapse — the Sheet owns the
  // container. Render the body directly.
  if (isSheet) return body;

  return (
    <>
      {/* Drag-to-resize handle on the panel's left edge — desktop, expanded
          only. Mirrors the conversation-list resizer in inbox-shell. */}
      {!effectiveCollapsed && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize contact details panel"
          aria-valuemin={260}
          aria-valuemax={520}
          aria-valuenow={expandedWidth}
          tabIndex={0}
          onPointerDown={onHandleDown}
          onKeyDown={onHandleKeyDown}
          className="group relative hidden w-1 shrink-0 cursor-col-resize touch-none select-none outline-none lg:block"
        >
          {/* Wide invisible grab zone so the thin indicator is still easy to grab. */}
          <span className="absolute inset-y-0 -left-1.5 -right-1.5 z-10" />
          {/* Thin, subtle resize indicator — transparent until hover / keyboard
              focus, so it never reads as a big translucent green bar. */}
          <span className="pointer-events-none absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 rounded-full bg-transparent transition-colors group-hover:bg-primary/60 group-focus-visible:bg-primary" />
        </div>
      )}
    <aside
      className="hidden h-full shrink-0 flex-col overflow-hidden border-l border-border bg-sidebar text-sidebar-foreground lg:flex"
      style={{
        // Suppress the collapse width-transition while actively dragging so the
        // resize tracks the pointer 1:1.
        width: effectiveCollapsed ? 48 : expandedWidth,
        transition: transitionEnabled && !resizing
          ? "width 250ms cubic-bezier(0.4, 0, 0.2, 1)"
          : "none",
      }}
    >
      {effectiveCollapsed ? (
        // Collapsed rail: a single expand button filling the thin rail.
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={toggleCollapsed}
              className="flex h-11 w-12 shrink-0 items-center justify-center border-b border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              aria-label="Expand contact panel"
            >
              <ChevronLeft className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="left">Contact details</TooltipContent>
        </Tooltip>
      ) : (
        // Expanded body. Fixed 320px inner width + shrink-0 so the dense
        // content never reflows/squashes while the aside animates its width —
        // it stays full-width and the shrinking aside (overflow-hidden) clips
        // it from the right, a clean slide-out. Unmounted when collapsed so it
        // can't stack under the rail button in the 48px column.
        body
      )}
      </aside>
    </>
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
  if (prev.variant !== next.variant) return false;
  if (prev.initialCollapsed !== next.initialCollapsed) return false;
  if (prev.initialDetailsWidth !== next.initialDetailsWidth) return false;
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
      ac.username !== bc.username ||
      ac.avatarUrl !== bc.avatarUrl ||
      !shallowJsonEqual({ ...ac.socialProfile }, { ...bc.socialProfile }) ||
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
