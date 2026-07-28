"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSoftRefresh } from "@/hooks/use-soft-refresh";
import { apiFetch } from "@/lib/api/client-fetch";
import {
  Download,
  ListChecks,
  History,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Search,
  Send,
  Trash2,
  Upload,
  Users,
  X,
  Tags as TagsIcon,
  MinusCircle,
} from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { toast } from "@/lib/toast";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { WindowBadge } from "@/features/inbox/components/window-badge";
import { ChannelBadge } from "@/features/inbox/components/channel-badge";
import { LocalTime } from "@/components/local-time";
import type { Channel } from "@ccp/shared/types";
import { apiErrorMessageFrom } from "@ccp/shared/api/error-message";
import { avatarGradient } from "@ccp/shared/utils/avatar-color";
import { cn, formatPhone, initials } from "@ccp/shared/utils";
import { TagChip, TagAddButton } from "@/features/tags/components/tag-chip";
import { TagMultiPicker } from "@/features/tags/components/tag-multi-picker";
import { tagColorClasses } from "@ccp/shared/utils/tag-colors";
import {
  TAG_COLORS,
  type TagColor,
} from "@ccp/shared/types";
import type {
  Contact,
  ContactFieldDefinition,
  ContactListItem,
  ContactPanelBuiltins,
  ContactStage,
  Tag,
} from "@ccp/shared/types";
import { getClientSocket } from "@/lib/socket-client";
import {
  ContactFilterBar,
  useContactList,
  type StageFilter,
} from "@/features/contacts/components/contact-browser";
import { SelectAllRow } from "@/features/contacts/components/contact-browser/select-all-row";
import { ContactRowsSkeleton } from "@/features/contacts/components/contact-browser/row-skeleton";
import { ContactStagePicker } from "@/features/contacts/components/contact-stage-picker";
import { Pagination } from "@/components/ui/pagination";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useChannelAccounts } from "@/features/channels/contexts/channel-accounts-context";

import dynamic from "next/dynamic";

// Three dialogs that only open via explicit user action — defer them out
// of the initial contacts-page bundle. SSR-disabled because they're
// interactive-only.
const ImportContactsWizard = dynamic(
  () =>
    import("@/features/contacts/components/transfer/import-wizard").then(
      (m) => m.ImportContactsWizard,
    ),
  { ssr: false },
);
const ExportContactsDialog = dynamic(
  () =>
    import("@/features/contacts/components/transfer/export-dialog").then(
      (m) => m.ExportContactsDialog,
    ),
  { ssr: false },
);
const TransferHistorySheet = dynamic(
  () =>
    import("@/features/contacts/components/transfer/transfer-history").then(
      (m) => m.TransferHistorySheet,
    ),
  { ssr: false },
);
const NewContactDialog = dynamic(
  () => import("./new-contact-dialog").then((m) => m.NewContactDialog),
  { ssr: false },
);
const ContactDetailDrawer = dynamic(
  () =>
    import("@/features/contacts/components/contact-detail-drawer").then(
      (m) => m.ContactDetailDrawer,
    ),
  { ssr: false },
);

/**
 * Render-cap, mirroring ContactBrowser (the picker). The contacts list isn't
 * virtualized; past ~2000 rich DOM rows the page gets laggy, so we stop
 * auto-loading and steer the user to refine filters instead of accumulating
 * unbounded pages. Lift this only by switching to the use-virtualizer pattern
 * (see conversation-list.tsx).
 */
const CONTACTS_PAGE_SIZE = 25;

/**
 * Contacts directory.
 *
 * Search / filter / pagination all live in the shared `useContactList` hook
 * (the same one the contact-picker dialog uses), so this component only owns
 * the page-specific bits: bulk-action selection, the create/import/edit
 * dialogs, and the team tag + field catalogs.
 */
export function ContactsClient({
  initialItems,
  initialNextCursor,
  initialTotalCount,
  fieldDefinitions: initialFieldDefinitions,
  contactPanelBuiltins,
  initialTags,
  initialStages,
  initialStageFilter,
  canManageFields,
  canManageStages,
  canDeleteContacts,
  canExportContacts,
}: {
  initialItems: ContactListItem[];
  initialNextCursor: string | null;
  /** Server-computed total matching the SSR filter set. Drives "Showing N of
   *  TOTAL"; `null` if the server didn't compute it. */
  initialTotalCount: number | null;
  fieldDefinitions: ContactFieldDefinition[];
  /** Admin-controlled visibility for the built-in contact rows. Forwarded to
   *  the detail drawer so it honors the same hide toggles as the inbox panel. */
  contactPanelBuiltins: ContactPanelBuiltins;
  initialTags: Tag[];
  initialStages: ContactStage[];
  initialStageFilter: StageFilter;
  canManageFields: boolean;
  canManageStages: boolean;
  canDeleteContacts: boolean;
  canExportContacts: boolean;
}) {
  const router = useRouter();
  const softRefresh = useSoftRefresh();
  const { confirm, confirmDialog } = useConfirm();
  const list = useContactList({
    initialItems,
    initialNextCursor,
    initialTotalCount,
    initialStageFilter,
    paged: true,
    pageSize: CONTACTS_PAGE_SIZE,
  });
  const { items, setItems, setError, reconcileContactUpdate, refetch, adjustTotalCount } =
    list;
  // Jump to a page and scroll back to the top so the new page starts at row 1.
  const goToPage = useCallback(
    (next: number) => {
      list.setPage(Math.min(Math.max(1, next), list.pageCount));
      if (typeof window !== "undefined") window.scrollTo({ top: 0 });
    },
    [list],
  );
  // Lifted to state so dialogs can splice in newly-created definitions
  // without waiting on a router.refresh round trip.
  //
  // Sync FROM props on every render: when `router.refresh()` (from
  // useCatalogSync's `team:catalog:changed` handler) re-runs SSR and
  // delivers new initialX props, we adopt them. Without this sync the
  // useState initializer captured the first-mount value and any
  // teammate's additions to the catalog wouldn't show up here — the
  // user had to refresh the browser. Local optimistic mutations are
  // still visible until the next refresh, then the server snapshot
  // takes over (correct: server is authoritative).
  // The workspace's channel accounts, for the "Account" filter. Fetched once —
  // the list changes only when an admin connects/disconnects a number, and the
  // menu hides itself when there are fewer than two to choose between.
  // From the app-wide directory (seeded once in the (app) layout), not a
  // per-page refetch of the same handful of rows.
  const { all: directoryAccounts } = useChannelAccounts();
  const channelAccounts = useMemo(
    () =>
      directoryAccounts
        .filter((a) => a.isActive)
        .map((a) => ({ id: a.id, channel: a.channel as string, name: a.name })),
    [directoryAccounts],
  );

  const [fieldDefinitions, setFieldDefinitions] =
    useState<ContactFieldDefinition[]>(initialFieldDefinitions);
  const [tags, setTags] = useState<Tag[]>(initialTags);
  const [stages, setStages] = useState<ContactStage[]>(initialStages);
  useEffect(() => {
    setFieldDefinitions(initialFieldDefinitions);
  }, [initialFieldDefinitions]);
  useEffect(() => {
    setTags(initialTags);
  }, [initialTags]);
  useEffect(() => {
    setStages(initialStages);
  }, [initialStages]);
  const tagById = useMemo(
    () => new Map(tags.map((t) => [t.id, t] as const)),
    [tags],
  );

  // Stable across renders (setItems from useContactList is stable) so the
  // memoized ContactRow doesn't bust on every parent render — a single
  // checkbox toggle then re-renders only the toggled row, not all ~2000.
  const patchContactStage = useCallback(
    (contactId: string, stageId: string | null) => {
      setItems((prev) =>
        prev.map((row) =>
          row.contact.id === contactId
            ? { ...row, contact: { ...row.contact, stageId } }
            : row,
        ),
      );
    },
    [setItems],
  );
  // Selection state for bulk actions. Set<string> keeps add/remove O(1) and
  // makes "select all on this page" a simple union.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  // "Select all N matching" mode (Gmail/HubSpot pattern). When the user has
  // selected every LOADED row but more contacts match the filter than are
  // loaded, a banner lets them escalate to "all matching": NON-DESTRUCTIVE
  // bulk ops (tag-add / tag-remove) then send the active FILTER instead of an
  // id array and the server applies the op to every matching contact. Delete
  // + send-template stay bound to the loaded selection (deliberate safety
  // limit — they never enter this mode).
  const [allMatching, setAllMatching] = useState(false);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [showTransfers, setShowTransfers] = useState(false);
  // Contact id whose detail drawer is open — null = closed. Storing the id
  // (not the row) means a list reconcile mid-edit doesn't lose the drawer.
  const [detailId, setDetailId] = useState<string | null>(null);
  // Snapshot of the open drawer's row so the drawer survives an inline edit
  // that moves the contact out of the active filter — `reconcileContactUpdate`
  // correctly drops the row from `items`, but `items.find` then returns
  // undefined mid-save and the drawer would unmount before the PATCH even
  // returns. We render from this snapshot (kept patched by contact:updated)
  // when the live row has dropped out.
  const detailRowRef = useRef<ContactListItem | null>(null);

  // Previous set of visible (loaded) ids, so the effect below can tell an
  // infinite-scroll append / reconcile (every prior id still present AND the
  // set grew) apart from a filter change or row removal (prior ids dropped) —
  // only the latter is allowed to demote "all matching".
  const prevVisibleIdsRef = useRef<Set<string>>(new Set());
  // Set for exactly one commit when the effect auto-joins a freshly loaded page
  // into an active "all matching" selection. That commit's render still sees the
  // new rows as unselected (allVisibleSelected=false) until the union setState
  // lands; without this flag the demotion effect would read that transient and
  // cancel the escalation from passive scrolling.
  const skipMatchingDemotionRef = useRef(false);

  // Keep `selectedIds` in step with the loaded rows:
  //  - infinite-scroll append / reconcile while "all matching" is active: union
  //    the new page into the selection so scrolling can't silently demote the
  //    escalation ("all N matching" means unloaded rows count too — a loaded but
  //    unselected page would contradict that).
  //  - otherwise (filter change, deletion): drop selected ids no longer visible.
  useEffect(() => {
    const visibleIds = new Set(items.map((i) => i.contact.id));
    const prevVisible = prevVisibleIdsRef.current;
    const isPureAppend =
      visibleIds.size > prevVisible.size &&
      Array.from(prevVisible).every((id) => visibleIds.has(id));
    prevVisibleIdsRef.current = visibleIds;
    if (allMatching && isPureAppend) {
      skipMatchingDemotionRef.current = true;
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of visibleIds) next.add(id);
        return next;
      });
      return;
    }
    skipMatchingDemotionRef.current = false;
    setSelectedIds((prev) => {
      const filtered = Array.from(prev).filter((id) => visibleIds.has(id));
      if (filtered.length === prev.size) return prev;
      return new Set(filtered);
    });
  }, [items, allMatching]);

  // "All matching" is only valid while every LOADED row is still selected —
  // it's an escalation OF a full-visible selection. The moment the selection
  // drops below all-visible (deselect a row, filter change pruned the set,
  // socket delete removed a selected row), fall back to plain visible-selection
  // semantics so a stale filter payload can't outlive the selection that
  // justified it. The ONE shortfall that must NOT demote is an infinite-scroll
  // append — the effect above re-unions the new page, and
  // `skipMatchingDemotionRef` swallows the single transient commit in between.
  const allVisibleSelected =
    items.length > 0 && items.every((i) => selectedIds.has(i.contact.id));
  useEffect(() => {
    if (skipMatchingDemotionRef.current) {
      skipMatchingDemotionRef.current = false;
      return;
    }
    if (allMatching && !allVisibleSelected) setAllMatching(false);
  }, [allMatching, allVisibleSelected]);

  // Live updates: when a teammate edits or deletes a contact elsewhere
  // (inbox panel, another tab, bulk-tag op, etc.), reflect it here without
  // a refresh. `reconcileContactUpdate` is filter-aware: it patches the row
  // in place when it still matches, drops it when an edit moves it out of
  // the filtered set (e.g. stage filter active, contact stage changed), and
  // refetches when an edit moves a previously-hidden contact INTO the set.
  // Deleted rows drop out of `items` AND `selectedIds` so a bulk action
  // can't target a gone contact.
  //
  // The deps are empty on purpose: `setItems` and `reconcileContactUpdate`
  // from `useContactList` are stable (the latter reads filters via a ref),
  // and capturing them in the closure once avoids re-binding the listener
  // every render.
  useEffect(() => {
    const socket = getClientSocket();
    const onContactUpdated = (payload: { contact: Contact }) => {
      // Keep the open-drawer snapshot fresh so an edit that drops the row out
      // of the filtered `items` still shows the just-edited values.
      if (
        detailRowRef.current &&
        detailRowRef.current.contact.id === payload.contact.id
      ) {
        detailRowRef.current = {
          ...detailRowRef.current,
          contact: payload.contact,
        };
      }
      reconcileContactUpdate(payload.contact);
    };
    const onContactDeleted = (payload: { contactId: string }) => {
      let wasPresent = false;
      setItems((prev) => {
        const next = prev.filter((row) => row.contact.id !== payload.contactId);
        wasPresent = next.length !== prev.length;
        return next;
      });
      // Only nudge the total when the row was actually present locally — a
      // delete for a contact filtered out of this view shouldn't move the
      // displayed total (the next page-1 fetch reconciles regardless).
      if (wasPresent) adjustTotalCount(-1);
      setSelectedIds((prev) => {
        if (!prev.has(payload.contactId)) return prev;
        const copy = new Set(prev);
        copy.delete(payload.contactId);
        return copy;
      });
    };
    // Coalesced "many contacts changed" — server fires this from bulk-tag
    // (and future bulk-stage / bulk-field) paths instead of N per-contact
    // events. Just refresh the visible page; the same code path the filter
    // change effect uses, but triggered by a remote bulk write.
    let bulkRefetchTimer: number | null = null;
    const onContactsBulkUpdated = () => {
      // Jitter the refetch (0–1500ms): a bulk op fans this one frame out to
      // EVERY connected client at once, so an un-jittered refetch would fire a
      // synchronized thundering-herd of full-page queries at the API in the same
      // instant (frontend-state-added-1). Coalesce rapid frames too.
      if (bulkRefetchTimer !== null) window.clearTimeout(bulkRefetchTimer);
      bulkRefetchTimer = window.setTimeout(() => {
        bulkRefetchTimer = null;
        refetch();
      }, Math.floor(Math.random() * 1500));
    };
    socket.on("contact:updated", onContactUpdated);
    socket.on("contact:deleted", onContactDeleted);
    socket.on("contacts:bulk_updated", onContactsBulkUpdated);
    return () => {
      if (bulkRefetchTimer !== null) window.clearTimeout(bulkRefetchTimer);
      socket.off("contact:updated", onContactUpdated);
      socket.off("contact:deleted", onContactDeleted);
      socket.off("contacts:bulk_updated", onContactsBulkUpdated);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Patch a single contact's tag list in-place — used when the per-row tag
  // picker saves. Avoids a router.refresh that would also reset selection.
  // useCallback for the same memo-stability reason as patchContactStage.
  const patchContactTags = useCallback(
    (contactId: string, tagIds: string[]) => {
      setItems((prev) =>
        prev.map((row) =>
          row.contact.id === contactId
            ? { ...row, contact: { ...row.contact, tagIds } }
            : row,
        ),
      );
    },
    [setItems],
  );

  // Stable row callbacks — these + the two patchers above are what let
  // ContactRow's React.memo actually fire. Each takes the contact id as an
  // argument instead of closing over it, so one function instance serves
  // every row.
  const handleSelectChange = useCallback((contactId: string, next: boolean) => {
    setSelectedIds((prev) => {
      const copy = new Set(prev);
      if (next) copy.add(contactId);
      else copy.delete(contactId);
      return copy;
    });
  }, []);
  const handleTagCreated = useCallback((t: Tag) => {
    setTags((prev) =>
      prev.some((x) => x.id === t.id)
        ? prev
        : [...prev, t].sort((a, b) => a.name.localeCompare(b.name)),
    );
  }, []);
  const handleOpenDetail = useCallback((contactId: string) => {
    setDetailId(contactId);
  }, []);

  // Single delete from the detail drawer. Mirrors the bulk-delete confirm +
  // local removal; the server also fans `contact:deleted` to other tabs.
  async function deleteOne(contactId: string) {
    const ok = await confirm({
      title: "Delete contact?",
      description:
        "This also removes their conversations, messages, and notes. This can't be undone.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    const res = await apiFetch(`/api/contacts/${contactId}`, { method: "DELETE" });
    if (!res.ok) {
      setError(await safeReadError(res));
      return;
    }
    setItems((prev) => prev.filter((row) => row.contact.id !== contactId));
    adjustTotalCount(-1);
    setSelectedIds((prev) => {
      if (!prev.has(contactId)) return prev;
      const copy = new Set(prev);
      copy.delete(contactId);
      return copy;
    });
    detailRowRef.current = null;
    setDetailId(null);
  }

  // Press "/" to jump to search — unless the user is already typing somewhere.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      if (
        el &&
        (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)
      ) {
        return;
      }
      const search = document.querySelector<HTMLInputElement>("[data-contacts-search]");
      if (search) {
        e.preventDefault();
        search.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // The search is broad enough — also matches inside customFields JSON — that
  // we don't need a "no results" hint per filter dimension. Just empty state.
  const showEmpty = !list.loading && items.length === 0;

  // More contacts match the current filter than are loaded into the page — the
  // precondition for offering "select all N matching". Mirrors the SSR/list
  // "Showing N of TOTAL" gate (totalCount is the server-authoritative match
  // count for the active filter).
  const hasMoreMatching =
    list.totalCount !== null && list.totalCount > items.length;

  // Build the server-side filter payload for a filter-mode bulk op. Mirrors
  // `fetchContactsPage`'s param mapping (the same filters the list query reads)
  // so the server's where-builder targets exactly the set the user sees. Only
  // non-default dimensions are included so the payload stays minimal.
  const buildBulkFilter = useCallback(() => {
    const f: {
      search?: string;
      fieldKey?: string;
      fieldValue?: string;
      source?: "inbound" | "manual";
      tagIds?: string[];
      window?: "open" | "closed";
      stageId?: string;
      channel?: Channel;
      accountId?: string;
    } = {};
    if (list.search.trim()) f.search = list.search.trim();
    if (list.fieldFilter) {
      f.fieldKey = list.fieldFilter.key;
      f.fieldValue = list.fieldFilter.value;
    }
    if (list.sourceFilter !== "all") f.source = list.sourceFilter;
    if (list.windowFilter !== "any") f.window = list.windowFilter;
    if (list.tagIds.length > 0) f.tagIds = list.tagIds;
    if (list.stageFilter !== "any") f.stageId = list.stageFilter;
    // Mirror `fetchContactsPage` exactly (contact-browser.tsx): person mode rolls
    // up across channels, so the list and its totalCount ignore `channel`.
    // Sending it here would resolve a channel-scoped SUBSET of the N persons the
    // user is looking at and clicked "select all N matching" on.
    if (!list.groupByPerson && list.channelFilter !== "any") f.channel = list.channelFilter;
    // Same person-mode carve-out as `channel`: a person spans accounts.
    if (!list.groupByPerson && list.accountFilter) f.accountId = list.accountFilter;
    return f;
  }, [
    list.search,
    list.fieldFilter,
    list.sourceFilter,
    list.windowFilter,
    list.tagIds,
    list.stageFilter,
    list.channelFilter,
    list.accountFilter,
    list.groupByPerson,
  ]);

  // Apply a tag op either to the loaded selection (id mode) or — when the user
  // escalated to "all matching" — to every matching contact server-side
  // (filter mode). Returns true on success. In all-matching mode we can't patch
  // rows locally (we don't hold all the ids), so we refetch the visible page;
  // the server's coalesced `contact.bulk_updated` frame reconciles other tabs.
  const applyTagBulk = useCallback(
    async (action: "tag-add" | "tag-remove", tagId: string): Promise<boolean> => {
      const body = allMatching
        ? { action, mode: "filter" as const, filter: buildBulkFilter(), tagId }
        : { action, contactIds: Array.from(selectedIds), tagId };
      if (!allMatching && (body as { contactIds: string[] }).contactIds.length === 0) {
        return false;
      }
      const res = await apiFetch("/api/contacts/bulk", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const msg = await safeReadError(res);
        setError(msg);
        toast.error(
          action === "tag-add" ? "Couldn't add tag" : "Couldn't remove tag",
          { description: msg },
        );
        return false;
      }
      if (allMatching) {
        const data = (await res
          .json()
          .catch(() => ({}))) as { count?: number; capped?: boolean };
        if (data.capped) {
          toast.warning(
            `Applied to the first ${(data.count ?? 0).toLocaleString()} contacts`,
            { description: "The match set was very large and was capped." },
          );
        }
        // Can't splice locally without the full id set — pull the fresh page.
        list.refetch();
      }
      return true;
    },
    [allMatching, buildBulkFilter, selectedIds, list, setError],
  );

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 md:px-8 md:py-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Contacts</h1>
          <p className="text-sm text-muted-foreground">
            People who messaged your team, plus anyone you add manually.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Secondary actions tucked behind one menu so the header stays
              calm — only the primary "New contact" CTA sits in the open. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" aria-label="More contact actions">
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              {canManageFields && (
                <DropdownMenuItem asChild>
                  <Link href="/settings/contact-fields">
                    <ListChecks className="size-4" />
                    Manage fields
                  </Link>
                </DropdownMenuItem>
              )}
              {canExportContacts && (
                <DropdownMenuItem onSelect={() => setExporting(true)}>
                  <Download className="size-4" />
                  Export contacts
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={() => setImporting(true)}>
                <Upload className="size-4" />
                Import contacts
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setShowTransfers(true)}>
                <History className="size-4" />
                Imports &amp; exports
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button onClick={() => setCreating(true)}>
            <Plus className="size-4" />
            New contact
          </Button>
        </div>
      </header>

      <div className="mb-3">
        <ContactFilterBar
          search={list.search}
          onSearchChange={list.setSearch}
          sourceFilter={list.sourceFilter}
          onSourceChange={list.setSourceFilter}
          channelFilter={list.channelFilter}
          onChannelChange={list.setChannelFilter}
          accountFilter={list.accountFilter}
          // Person mode rolls a customer UP across their channel-contacts, so
          // scoping to one account would return a subset of the people on
          // screen — the query correctly drops the filter there. Hiding the
          // control (rather than leaving it lit and inert) is the honest half:
          // a filter that reads as applied and isn't is worse than none.
          onAccountChange={list.groupByPerson ? undefined : list.setAccountFilter}
          accounts={channelAccounts}
          windowFilter={list.windowFilter}
          onWindowChange={list.setWindowFilter}
          fieldFilter={list.fieldFilter}
          onFieldChange={list.setFieldFilter}
          fieldDefinitions={fieldDefinitions}
          tags={tags}
          selectedTagIds={list.tagIds}
          onTagsChange={list.setTagIds}
          stages={stages}
          stageFilter={list.stageFilter}
          onStageFilterChange={list.setStageFilter}
        />
        {/* Roll the list up to ONE row per unified person (a Customer + their
            channels) instead of one row per channel-contact. Opt-in — the
            default flat directory shows every channel identity explicitly. */}
        <button
          type="button"
          onClick={() => list.setGroupByPerson(!list.groupByPerson)}
          aria-pressed={list.groupByPerson}
          title="Show one row per person instead of per channel-contact"
          className={cn(
            "mt-2 inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition",
            list.groupByPerson
              ? "border-primary bg-primary/10 text-foreground"
              : "border-border text-muted-foreground hover:text-foreground",
          )}
        >
          <Users className="size-3.5" />
          Group by person
        </button>
      </div>

      {list.error && (
        <div
          role="alert"
          className="mb-3 rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {list.error}
        </div>
      )}

      <div
        className={cn(
          "rounded-lg border border-border bg-card transition-opacity",
          // Dim in place during a page/filter refetch so the interaction reads
          // as busy (matches broadcasts + templates), instead of leaving stale
          // rows at full opacity with only the far-down pagination disabled.
          list.loading && items.length > 0 && "pointer-events-none opacity-60",
        )}
      >
        {list.loading && items.length === 0 ? (
          <ContactRowsSkeleton count={CONTACTS_PAGE_SIZE} />
        ) : showEmpty ? (
          (() => {
            const filtered =
              list.search ||
              list.fieldFilter ||
              list.windowFilter !== "any" ||
              list.stageFilter !== "any" ||
              list.sourceFilter !== "all" ||
              list.tagIds.length > 0;
            return (
              <EmptyState
                icon={Users}
                className="border-0 bg-transparent py-16"
                title={filtered ? "No contacts match your filters" : "No contacts yet"}
                description={
                  filtered
                    ? "Try clearing a filter or adjusting your search."
                    : "People who message your team show up here automatically — or add one manually."
                }
                action={
                  filtered ? undefined : (
                    <Button onClick={() => setCreating(true)}>
                      <Plus className="size-4" />
                      New contact
                    </Button>
                  )
                }
              />
            );
          })()
        ) : (
          <>
            <SelectAllRow
              items={items}
              selectedIds={selectedIds}
              onToggleAll={(checked, visibleIds) => {
                // Replace semantics — the page drops non-visible selections
                // whenever filters change (see the effect on `items`), so
                // "select all visible" naturally means "set to visible".
                if (checked) setSelectedIds(new Set(visibleIds));
                else setSelectedIds(new Set());
              }}
              rightSlot={
                // Just the total here — the "X–Y of N" range lives in the
                // <Pagination> summary below, so two differently-phrased
                // "Showing…" labels don't sit on the same screen.
                <span className="tabular-nums">
                  {(() => {
                    const n = list.totalCount ?? items.length;
                    const label = list.groupByPerson
                      ? n === 1
                        ? "person"
                        : "people"
                      : n === 1
                        ? "contact"
                        : "contacts";
                    return `${n.toLocaleString()} ${label}`;
                  })()}
                </span>
              }
            />
            {/* "Select all N matching" banner (Gmail/HubSpot pattern). Shows
                once every LOADED row is selected AND more contacts match the
                filter than are loaded. Escalating switches NON-DESTRUCTIVE bulk
                ops (tag add/remove) to filter mode — the server applies them to
                every matching contact. */}
            {allVisibleSelected && (hasMoreMatching || allMatching) && (
              <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 border-b border-border bg-primary/5 px-4 py-2 text-center text-xs text-muted-foreground">
                {allMatching ? (
                  <>
                    <span className="font-medium text-foreground tabular-nums">
                      All {(list.totalCount ?? items.length).toLocaleString()} matching
                      contacts selected.
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setAllMatching(false);
                        setSelectedIds(new Set());
                      }}
                      className="font-medium text-primary hover:underline"
                    >
                      Clear selection
                    </button>
                  </>
                ) : (
                  <>
                    <span className="tabular-nums">
                      All {items.length.toLocaleString()} on this page selected.
                    </span>
                    <button
                      type="button"
                      onClick={() => setAllMatching(true)}
                      className="font-medium text-primary hover:underline tabular-nums"
                    >
                      Select all {(list.totalCount ?? items.length).toLocaleString()} matching
                    </button>
                  </>
                )}
              </div>
            )}
            {/* @container so each row's metadata lanes show/hide based on the
                LIST's real width, not the viewport — the list narrows when the
                section sub-sidebar is present (md+), and viewport breakpoints
                couldn't see that, which squeezed the name to nothing. */}
            <ul className="@container divide-y divide-border">
              {items.map((item) => (
                <ContactRow
                  key={item.contact.id}
                  item={item}
                  tagCatalog={tags}
                  tagById={tagById}
                  stageCatalog={stages}
                  canManageStages={canManageStages}
                  selected={selectedIds.has(item.contact.id)}
                  onSelectChange={handleSelectChange}
                  onTagsChanged={patchContactTags}
                  onTagCreated={handleTagCreated}
                  onStageChanged={patchContactStage}
                  onOpen={handleOpenDetail}
                />
              ))}
            </ul>
          </>
        )}
      </div>

      {!list.loading && items.length > 0 && (
        <Pagination
          className="mt-4"
          page={list.page}
          pageCount={list.pageCount}
          onPageChange={goToPage}
          totalCount={list.totalCount ?? undefined}
          pageSize={CONTACTS_PAGE_SIZE}
          itemNoun="contacts"
          disabled={list.loading}
        />
      )}

      {importing && (
        <ImportContactsWizard
          onClose={() => setImporting(false)}
          onImported={() => {
            // NOTE: the wizard stays OPEN — it's showing the result summary and
            // the failed-rows download. Only refresh the list underneath.
            //
            // Refetch from the server so imported rows appear immediately —
            // don't rely on the one-shot `contacts:bulk_updated` socket frame
            // (a dropped/disconnected frame would leave them invisible until a
            // filter change). softRefresh reconciles the rest of the RSC (e.g.
            // SSR-seeded counts).
            list.refetch();
            softRefresh();
          }}
        />
      )}

      {exporting && (
        <ExportContactsDialog
          onClose={() => setExporting(false)}
          // Each filter carries an "all"/"any" sentinel meaning "not filtering";
          // those must become `undefined`, not be sent as a literal value the
          // server would try to match a column against.
          filters={{
            search: list.search || undefined,
            source: list.sourceFilter === "all" ? undefined : list.sourceFilter,
            channel: list.channelFilter === "any" ? undefined : list.channelFilter,
            window: list.windowFilter === "any" ? undefined : list.windowFilter,
            // "none" is a REAL filter (contacts with no stage) — only "any" opts out.
            stageId: list.stageFilter === "any" ? undefined : list.stageFilter,
            tagIds: list.tagIds.length > 0 ? list.tagIds : undefined,
            fieldKey: list.fieldFilter?.key,
            fieldValue: list.fieldFilter?.value,
          }}
          selectedIds={[...selectedIds]}
          filteredCount={list.totalCount ?? 0}
        />
      )}

      {showTransfers && <TransferHistorySheet onClose={() => setShowTransfers(false)} />}

      <BulkActionBar
        selectedCount={selectedIds.size}
        // In all-matching mode the bar reflects the TRUE total (the server
        // applies to every match), not the loaded-row count.
        effectiveCount={
          allMatching ? list.totalCount ?? selectedIds.size : selectedIds.size
        }
        allMatching={allMatching}
        tags={tags}
        onTagCreatedAndApply={async (tag) => {
          // Splice the new tag into the catalog so the chips render and
          // future picker opens show it. Then apply to the current bulk.
          setTags((prev) =>
            prev.some((x) => x.id === tag.id)
              ? prev
              : [...prev, tag].sort((a, b) => a.name.localeCompare(b.name)),
          );
          const ok = await applyTagBulk("tag-add", tag.id);
          // Local patch only meaningful in id mode — applyTagBulk already
          // refetched in all-matching mode.
          if (ok && !allMatching) {
            const ids = new Set(selectedIds);
            setItems((prev) =>
              prev.map((row) => {
                if (!ids.has(row.contact.id)) return row;
                const cur = row.contact.tagIds ?? [];
                return cur.includes(tag.id)
                  ? row
                  : { ...row, contact: { ...row.contact, tagIds: [...cur, tag.id] } };
              }),
            );
          }
        }}
        onClear={() => {
          setAllMatching(false);
          setSelectedIds(new Set());
        }}
        onSendTemplate={() => {
          // Send-template is DELIBERATELY id-scoped (never filter-mode): the
          // broadcast wizard takes a contactId/tagId set, not the full contacts
          // filter, and that surface is out of scope here. So it always targets
          // the loaded selection — even in all-matching mode.
          const ids = Array.from(selectedIds);
          if (ids.length === 0) return;
          router.push(`/broadcasts/new?contactIds=${ids.join(",")}`);
        }}
        onTagBulk={async (action, tagId) => {
          const ok = await applyTagBulk(action, tagId);
          // Patch each affected row's tagIds locally so the chips update
          // immediately (id mode only — all-matching refetched the page).
          if (ok && !allMatching) {
            const ids = new Set(selectedIds);
            setItems((prev) =>
              prev.map((row) => {
                if (!ids.has(row.contact.id)) return row;
                const cur = row.contact.tagIds ?? [];
                const next =
                  action === "tag-add"
                    ? cur.includes(tagId)
                      ? cur
                      : [...cur, tagId]
                    : cur.filter((id) => id !== tagId);
                return { ...row, contact: { ...row.contact, tagIds: next } };
              }),
            );
          }
        }}
        onDelete={async () => {
          // Delete stays bound to the loaded selection — it NEVER enters
          // all-matching/filter mode (a deliberate safety limit: a filter-wide
          // purge can't go through, since WhatsApp history is unrecoverable).
          const ids = Array.from(selectedIds);
          if (ids.length === 0) return;
          // Meta Cloud has no history sync, so deleted WhatsApp history is
          // unrecoverable. For large blast radius (>25) require typing DELETE
          // so a big purge can't go through on the same reflexive click as a
          // single-row delete.
          const requireTyped = ids.length > 25;
          const ok = await confirm({
            title: `Delete ${ids.length} contact${ids.length === 1 ? "" : "s"}?`,
            description:
              "This also removes their conversations, messages, and notes. WhatsApp history can't be recovered. This can't be undone.",
            confirmLabel: "Delete",
            destructive: true,
            ...(requireTyped
              ? {
                  requireText: "DELETE",
                  requireTextLabel: (
                    <>
                      Type{" "}
                      <span className="font-semibold text-foreground">DELETE</span>{" "}
                      to remove {ids.length} contacts
                    </>
                  ),
                }
              : {}),
          });
          if (!ok) return;
          const res = await apiFetch("/api/contacts/bulk", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "delete", contactIds: ids }),
          });
          if (!res.ok) {
            const msg = await safeReadError(res);
            setError(msg);
            toast.error("Couldn't delete contacts", { description: msg });
            return;
          }
          setItems((prev) => prev.filter((row) => !ids.includes(row.contact.id)));
          adjustTotalCount(-ids.length);
          setSelectedIds(new Set());
        }}
        canDelete={canDeleteContacts}
      />

      {detailId && (() => {
        const liveRow = items.find((x) => x.contact.id === detailId);
        if (liveRow) detailRowRef.current = liveRow;
        // Fall back to the snapshot when an inline edit has just dropped the
        // row out of the filtered list — the drawer stays open over the
        // in-flight save instead of vanishing.
        const row =
          detailRowRef.current && detailRowRef.current.contact.id === detailId
            ? detailRowRef.current
            : (liveRow ?? null);
        if (!row) return null;
        return (
          <ContactDetailDrawer
            contact={row.contact}
            fieldDefinitions={fieldDefinitions}
            builtins={contactPanelBuiltins}
            tagCatalog={tags}
            stageCatalog={stages}
            canManageFields={canManageFields}
            canManageStages={canManageStages}
            activeConversationId={row.activeConversationId}
            lastInboundAt={row.lastInboundAt}
            onClose={() => {
              detailRowRef.current = null;
              setDetailId(null);
            }}
            onDelete={() => void deleteOne(detailId)}
            canDelete={canDeleteContacts}
            onTagCreated={(t) => {
              setTags((prev) =>
                prev.some((x) => x.id === t.id)
                  ? prev
                  : [...prev, t].sort((a, b) => a.name.localeCompare(b.name)),
              );
            }}
            onTeamWideFieldAdded={(def) => {
              setFieldDefinitions((prev) =>
                prev.some((d) => d.id === def.id)
                  ? prev
                  : [...prev, def].sort((a, b) => a.order - b.order),
              );
            }}
          />
        );
      })()}

      {creating && (
        <NewContactDialog
          fieldDefinitions={fieldDefinitions}
          canManageFields={canManageFields}
          onClose={() => setCreating(false)}
          onCreated={(item) => {
            // Splice to top so the new contact is visible without a refetch.
            // The server-side sort puts contacts with no messages by createdAt,
            // and this one was just created, so this matches the canonical
            // order. No softRefresh() here — the optimistic splice already shows
            // the row, and a refetch would churn the list (and reset selection)
            // for a single create; the next catalog/socket sync converges it.
            setItems((prev) => [item, ...prev]);
            adjustTotalCount(1);
            setCreating(false);
            toast.success("Contact added");
          }}
          onTeamWideFieldAdded={(def) => {
            setFieldDefinitions((prev) =>
              // Server enforces unique keys; defensive dedupe in case the
              // server-rendered list already had it (e.g. created in another
              // tab).
              prev.some((d) => d.id === def.id)
                ? prev
                : [...prev, def].sort((a, b) => a.order - b.order),
            );
          }}
        />
      )}
      {confirmDialog}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const ContactRow = memo(function ContactRow({
  item,
  tagCatalog,
  tagById,
  stageCatalog,
  canManageStages,
  selected,
  onSelectChange,
  onTagsChanged,
  onTagCreated,
  onStageChanged,
  onOpen,
}: {
  item: ContactListItem;
  tagCatalog: Tag[];
  tagById: Map<string, Tag>;
  stageCatalog: ContactStage[];
  canManageStages: boolean;
  selected: boolean;
  // Callbacks take the contact id so the parent can pass ONE stable
  // function per callback (not a per-row closure) — that's what makes the
  // surrounding React.memo effective.
  onSelectChange: (id: string, next: boolean) => void;
  onTagsChanged: (id: string, tagIds: string[]) => void;
  onTagCreated: (tag: Tag) => void;
  onStageChanged: (id: string, stageId: string | null) => void;
  /** Open the detail drawer for this contact. */
  onOpen: (id: string) => void;
}) {
  const { contact, activeConversationId, lastMessageAt, lastInboundAt, personChannels } = item;
  const [tagPickerOpen, setTagPickerOpen] = useState(false);
  const [tagSaveError, setTagSaveError] = useState<string | null>(null);
  const tagBoxRef = useRef<HTMLDivElement>(null);

  // Close on outside click. Avoids the picker hanging around when the agent
  // tabs to another row.
  useEffect(() => {
    if (!tagPickerOpen) return;
    function handler(e: MouseEvent) {
      if (!tagBoxRef.current) return;
      if (!tagBoxRef.current.contains(e.target as Node)) setTagPickerOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [tagPickerOpen]);

  const contactTags = (contact.tagIds ?? [])
    .map((id) => tagById.get(id))
    .filter((t): t is Tag => Boolean(t));
  // Lean rows show at most two tags; the rest live in the drawer.
  const shownTags = contactTags.slice(0, 2);
  const extraTags = contactTags.length - shownTags.length;

  async function persistTagIds(nextIds: string[]) {
    // Optimistic: parent already painted the new state; rollback on failure.
    const prevIds = contact.tagIds ?? [];
    onTagsChanged(contact.id, nextIds);
    setTagSaveError(null);
    try {
      const res = await apiFetch(`/api/contacts/${contact.id}/tags`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tagIds: nextIds }),
      });
      if (!res.ok) throw new Error(await safeReadError(res));
    } catch (err) {
      onTagsChanged(contact.id, prevIds);
      setTagSaveError(err instanceof Error ? err.message : "Failed");
    }
  }

  async function persistStage(nextStageId: string) {
    const prev = contact.stageId ?? null;
    onStageChanged(contact.id, nextStageId);
    const res = await apiFetch(`/api/contacts/${contact.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stageId: nextStageId }),
    });
    if (!res.ok) {
      onStageChanged(contact.id, prev);
      toast.error("Couldn't change stage", {
        description: await safeReadError(res),
      });
    }
  }

  return (
    <li
      onClick={() => onOpen(contact.id)}
      className={cn(
        "group flex cursor-pointer items-center gap-3 px-4 py-2.5 transition-colors hover:bg-accent/50",
        selected && "bg-primary/5 hover:bg-primary/5",
      )}
    >
      {/* Selection checkbox — its own click never opens the drawer. */}
      <label
        onClick={(e) => e.stopPropagation()}
        className="flex shrink-0 cursor-pointer items-center justify-center"
      >
        <input
          type="checkbox"
          className="size-4 cursor-pointer accent-primary"
          checked={selected}
          onChange={(e) => onSelectChange(contact.id, e.target.checked)}
          aria-label={`Select ${contact.name || contact.phoneNumber}`}
        />
      </label>

      <Avatar className="size-8 shrink-0">
        {contact.avatarUrl ? <AvatarImage src={contact.avatarUrl} alt="" /> : null}
        <AvatarFallback
          className="text-xs text-white"
          style={{ backgroundImage: avatarGradient(contact.id) }}
        >
          {initials(contact.name || contact.phoneNumber || "?")}
        </AvatarFallback>
      </Avatar>

      {/* Name + phone — the keyboard-accessible "open contact" control. The two
          STACK vertically so the name gets the column's full width instead of
          competing inline with the (shrink-0) phone, which squeezed it down to
          "A…" on narrow widths. The phone line is omitted when there's no name
          (the name line already shows the phone then). */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onOpen(contact.id);
        }}
        className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left"
      >
        <span className="flex w-full items-center gap-1.5">
          <span className="truncate text-sm font-medium leading-tight">
            {contact.name || formatPhone(contact.phoneNumber)}
          </span>
          {/* Person mode: the cluster of every channel this person is reachable
              on. Default (per-contact) mode: the single channel badge. */}
          {personChannels && personChannels.length > 0 ? (
            <span className="flex shrink-0 items-center gap-0.5">
              {personChannels.map((ch) => (
                <ChannelBadge key={ch} channel={ch} className="size-3.5 shrink-0" />
              ))}
            </span>
          ) : (
            contact.identityChannel && (
              <ChannelBadge
                channel={contact.identityChannel}
                className="size-3.5 shrink-0"
              />
            )
          )}
        </span>
        {contact.name && (
          <span className="w-full truncate font-mono text-2xs tabular-nums leading-tight text-muted-foreground">
            {formatPhone(contact.phoneNumber)}
          </span>
        )}
      </button>

      {/* Interactive right cluster — clicks here never open the drawer.
          Each child is a fixed-width "lane" so columns line up vertically down
          the list (matches the design's aligned-lanes treatment). Lanes still
          reserve their width when empty, so a row with no tags/time/chat keeps
          the same column rhythm as its neighbours. */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground"
      >
        {/* Tags lane (no overflow-clip here — it would cut off the tag picker
            popover, which is absolutely positioned inside this box). */}
        <div
          ref={tagBoxRef}
          className="relative hidden w-44 shrink-0 items-center justify-end @xl:flex"
        >
          {/* Clipped inner row: tag chips can NEVER spill left out of the 176px
              lane and overlap the phone/name. The picker popover below is a
              SIBLING of this clip (still inside the `relative` lane) so it's not
              cut off — that's why the lane itself stays un-clipped. The add
              button is icon-only here so chip NAMES (not just their color dots)
              have room. */}
          <div className="flex min-w-0 flex-1 items-center justify-end gap-1 overflow-hidden">
            {shownTags.map((t) => (
              <TagChip key={t.id} tag={t} size="xs" />
            ))}
            {extraTags > 0 && (
              <span className="shrink-0 text-3xs text-muted-foreground">
                +{extraTags}
              </span>
            )}
            <TagAddButton
              size="xs"
              iconOnly
              className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
              onClick={() => setTagPickerOpen((v) => !v)}
            />
            {tagSaveError && (
              <span className="shrink-0 text-3xs text-destructive">
                {tagSaveError}
              </span>
            )}
          </div>
          {tagPickerOpen && (
            <div className="absolute right-0 top-full z-20 mt-1">
              <TagMultiPicker
                tags={tagCatalog}
                selectedIds={contact.tagIds ?? []}
                onSelectedChange={(next) => void persistTagIds(next)}
                onCreated={(tag) => {
                  onTagCreated(tag);
                  void persistTagIds([...(contact.tagIds ?? []), tag.id]);
                }}
              />
            </div>
          )}
        </div>

        {/* Stage lane — hidden on phones so the name keeps its width; stage
            stays editable from the row's detail drawer. */}
        <div className="hidden w-28 shrink-0 items-center justify-start @md:flex">
          <ContactStagePicker
            stages={stageCatalog}
            currentStageId={contact.stageId}
            onChange={persistStage}
            canManage={canManageStages}
            size="xs"
          />
        </div>

        {/* Window lane — wide enough for the longest one-line badge
            ("Window closed · closed 24m ago") so it never wraps or clips. */}
        <div className="hidden w-52.5 shrink-0 items-center justify-start @3xl:flex">
          <WindowBadge
            lastInboundAt={lastInboundAt}
            channel={contact.identityChannel ?? undefined}
            size="xs"
          />
        </div>

        {/* Time lane */}
        <div className="hidden w-12 shrink-0 items-center justify-end @5xl:flex">
          {lastMessageAt && (
            <LocalTime
              iso={lastMessageAt}
              format="listTime"
              className="text-right tabular-nums"
            />
          )}
        </div>

        {/* Open-chat lane — hidden on phones (tap the row → detail drawer to
            open the chat); reclaims the reserved width so the name doesn't
            collapse on a 375px screen. */}
        <div className="hidden w-26 shrink-0 items-center justify-end @4xl:flex">
          {activeConversationId && (
            <Link
              href={`/inbox/${activeConversationId}`}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
              title="Open chat"
            >
              <MessageSquare className="size-3" />
              <span>Open chat</span>
            </Link>
          )}
        </div>
      </div>
    </li>
  );
});

async function safeReadError(res: Response): Promise<string> {
  try {
    const json = (await res.json()) as { error?: string; detail?: string };
    if (json.detail) return `${json.error ?? "error"}: ${json.detail}`;
    return apiErrorMessageFrom(json, `HTTP ${res.status}`);
  } catch {
    return `HTTP ${res.status}`;
  }
}

function BulkActionBar({
  selectedCount,
  effectiveCount,
  allMatching,
  tags,
  onClear,
  onSendTemplate,
  onTagBulk,
  onTagCreatedAndApply,
  onDelete,
  canDelete,
}: {
  /** Loaded-page selection size — drives the show/hide gate. */
  selectedCount: number;
  /** Number the bar DISPLAYS. Equals selectedCount in id mode; equals the
   *  filter's true total in all-matching mode (tag ops apply to every match). */
  effectiveCount: number;
  /** True when the user escalated to "select all N matching" — tag ops then run
   *  server-side over the whole filter. Send-template + delete stay id-scoped. */
  allMatching: boolean;
  tags: Tag[];
  onClear: () => void;
  onSendTemplate: () => void;
  onTagBulk: (action: "tag-add" | "tag-remove", tagId: string) => void | Promise<void>;
  /** Called by the menu when an agent creates a brand-new tag in-flow.
   *  Parent persists it to the team catalog + applies to the bulk selection. */
  onTagCreatedAndApply: (tag: Tag) => void | Promise<void>;
  onDelete: () => void | Promise<void>;
  canDelete: boolean;
}) {
  // Local UI state for the tag popovers. Kept inside the bar so the parent
  // doesn't have to track which popover is open.
  const [openMenu, setOpenMenu] = useState<null | "add" | "remove">(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!openMenu) return;
    function handler(e: MouseEvent) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpenMenu(null);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [openMenu]);

  if (selectedCount === 0) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center px-4">
      <div
        ref={containerRef}
        className="pointer-events-auto relative flex max-w-[calc(100vw-2rem)] flex-wrap items-center justify-center gap-2 rounded-2xl border border-border bg-popover px-3 py-2 shadow-2xl ring-1 ring-foreground/5 *:shrink-0 sm:flex-nowrap sm:overflow-x-auto sm:rounded-full"
      >
        <span className="inline-flex h-7 items-center gap-1.5 rounded-full bg-primary/10 px-2.5 text-xs font-medium text-primary tabular-nums">
          {effectiveCount.toLocaleString()} {allMatching ? "matching" : "selected"}
        </span>

        <Button
          size="sm"
          className="gap-1.5"
          onClick={onSendTemplate}
          aria-label="Send template"
          title={
            allMatching
              ? "Send template (applies to the loaded selection, not all matching)"
              : "Send template"
          }
        >
          <Send className="size-3.5" />
          <span className="hidden sm:inline">Send template</span>
        </Button>

        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => setOpenMenu(openMenu === "add" ? null : "add")}
          aria-label="Add tag"
          title="Add tag"
        >
          <TagsIcon className="size-3.5" />
          <span className="hidden sm:inline">Add tag</span>
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => setOpenMenu(openMenu === "remove" ? null : "remove")}
          aria-label="Remove tag"
          title="Remove tag"
        >
          <MinusCircle className="size-3.5" />
          <span className="hidden sm:inline">Remove tag</span>
        </Button>

        {canDelete && (
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={onDelete}
            aria-label="Delete selected"
            title={
              allMatching
                ? "Delete (loaded selection only — all-matching delete is disabled)"
                : "Delete selected"
            }
          >
            <Trash2 className="size-3.5" />
            <span className="hidden sm:inline">Delete</span>
          </Button>
        )}

        <button
          type="button"
          onClick={onClear}
          className="inline-flex size-7 cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground pointer-coarse:size-9"
          aria-label="Clear selection"
        >
          <X className="size-4" />
        </button>

        {openMenu && (
          <BulkTagMenu
            tags={tags}
            action={openMenu === "add" ? "tag-add" : "tag-remove"}
            // Keep the menu open after a pick/create so an agent can apply
            // several tags in one pass — it closes on outside-click (the
            // effect above) or the explicit Cancel button.
            onPick={async (tagId) => {
              await onTagBulk(openMenu === "add" ? "tag-add" : "tag-remove", tagId);
            }}
            onCreated={async (tag) => {
              await onTagCreatedAndApply(tag);
            }}
            onClose={() => setOpenMenu(null)}
          />
        )}
      </div>
    </div>
  );
}

function BulkTagMenu({
  tags,
  action,
  onPick,
  onCreated,
  onClose,
}: {
  tags: Tag[];
  action: "tag-add" | "tag-remove";
  /** Apply an existing tag id to the current bulk selection. */
  onPick: (tagId: string) => void;
  /** Persist a new tag, then apply it. Only used for "tag-add". */
  onCreated: (tag: Tag) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [newColor, setNewColor] = useState<TagColor>("sky");
  const [createError, setCreateError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tags;
    return tags.filter((t) => t.name.toLowerCase().includes(q));
  }, [tags, query]);

  const exactMatch = useMemo(() => {
    const q = query.trim();
    if (!q) return null;
    return tags.find((t) => t.name.toLowerCase() === q.toLowerCase()) ?? null;
  }, [tags, query]);

  // Inline create is only meaningful in "add" mode — you can't remove a tag
  // that doesn't exist. Also gated on the typed query being non-empty + not
  // an exact match.
  const canCreate = action === "tag-add" && query.trim().length > 0 && !exactMatch;

  async function createTag() {
    const name = query.trim();
    if (!name || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const res = await apiFetch("/api/workspace/tags", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, color: newColor }),
      });
      const data = (await res.json()) as { tag?: Tag; error?: string; detail?: string };
      if (!res.ok || !data.tag) {
        throw new Error(
          [data.error, data.detail].filter(Boolean).join(": ") || `HTTP ${res.status}`,
        );
      }
      onCreated(data.tag);
      setQuery("");
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="absolute bottom-full left-1/2 mb-2 w-72 -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-popover shadow-xl">
      <div className="border-b border-border px-3 py-2 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        {action === "tag-add" ? "Add tag to selection" : "Remove tag from selection"}
      </div>

      <div className="border-b border-border px-2 py-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCreateError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canCreate) {
                e.preventDefault();
                void createTag();
              }
            }}
            placeholder={
              action === "tag-add" ? "Search or create a tag…" : "Search tags…"
            }
            className="h-8 pl-7 text-xs"
          />
        </div>
      </div>

      <div className="max-h-56 overflow-y-auto py-1">
        {filtered.length === 0 && !canCreate ? (
          <div className="px-3 py-3 text-center text-xs text-muted-foreground">
            {action === "tag-remove"
              ? "No tags to remove."
              : "Type a name above to create your first tag."}
          </div>
        ) : (
          filtered.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => onPick(t.id)}
              className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-accent"
            >
              <TagChip tag={t} size="xs" />
            </button>
          ))
        )}
      </div>

      {canCreate && (
        <div className="border-t border-border bg-muted/30 px-3 py-2">
          <div className="mb-1.5 text-3xs uppercase tracking-wide text-muted-foreground">
            Create new
          </div>
          <div className="flex items-center gap-2">
            <TagChip
              tag={{
                id: "preview",
                workspaceId: "preview",
                name: query.trim() || "new tag",
                color: newColor,
              }}
              size="sm"
            />
            <button
              type="button"
              onClick={() => void createTag()}
              disabled={creating}
              className="ml-auto inline-flex cursor-pointer items-center gap-1 rounded-md bg-primary px-2 py-1 text-2xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
            >
              {creating ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Plus className="size-3" />
              )}
              Create &amp; apply
            </button>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1">
            {TAG_COLORS.map((c) => {
              const colors = tagColorClasses(c);
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => setNewColor(c)}
                  className={cn(
                    "size-5 cursor-pointer rounded-full ring-1 ring-border transition-transform",
                    colors.solid,
                    newColor === c && "ring-2 ring-offset-2 ring-offset-popover ring-foreground/60 scale-110",
                  )}
                  aria-label={`${c} color`}
                />
              );
            })}
          </div>
          {createError && (
            <div className="mt-2 text-3xs text-destructive">{createError}</div>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={onClose}
        className="block w-full cursor-pointer border-t border-border px-3 py-1.5 text-center text-2xs text-muted-foreground transition-colors hover:bg-accent"
      >
        Cancel
      </button>
    </div>
  );
}


