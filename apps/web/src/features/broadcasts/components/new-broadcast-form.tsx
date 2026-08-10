"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  CalendarClock,
  Check,
  ChevronRight,
  Clock,
  FileText,
  Loader2,
  RefreshCw,
  Search,
  Send,
  Tag as TagIcon,
  Users,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { cn } from "@ccp/shared/utils";
import {
  requiredCarouselCards,
  requiredTemplateButtonParams,
  templateNamedPlaceholders,
  templateNeedsOfferExpiry,
  unsupportedTemplateFeature,
} from "@ccp/shared/template-render";
import {
  CampaignAssignment,
  EMPTY_CAMPAIGN_ASSIGNMENT,
  type CampaignAssignmentValue,
} from "@/features/broadcasts/components/campaign-assignment";
import type {
  ContactFieldDefinition,
  ContactFieldFilter,
  ContactStage,
  Tag,
  TemplateDto,
} from "@ccp/shared/types";
import { CHANNEL_LABEL } from "@/features/inbox/components/channel-badge";
import {
  CHANNEL_CAPABILITIES,
  isAccountScopedIdentity,
} from "@ccp/shared/providers/capabilities";
import type { ContactLabel } from "@/features/contacts/components/contact-select-dialog";
import type { TemplateComponent } from "@ccp/shared/providers/types";
import type { AudienceGroupDto } from "@ccp/shared/dtos";
import { apiErrorMessageFrom } from "@ccp/shared/api/error-message";
import {
  findUnknownTokens,
  resolveFieldTokens,
  SAMPLE_CONTACT,
} from "@ccp/shared/field-tokens";
import { parseVariableBindings, type VariableBinding } from "@ccp/shared/template-bindings";

import { apiFetch } from "@/lib/api/client-fetch";
import { useAudienceCount } from "@/hooks/use-audience-count";
import { toast } from "@/lib/toast";
import { AudiencePicker, type AudienceState } from "@/features/broadcasts/components/audience-picker";
import { RecipientsPreviewDialog } from "@/features/broadcasts/components/recipients-preview-dialog";
import { FieldTokenPicker } from "@/features/templates/components/field-token-picker";
import { HeaderMediaField } from "@/features/templates/components/header-media-field";
import {
  CarouselCardsField,
  carouselCardsComplete,
  emptyCarouselCards,
  type CarouselCardValue,
} from "@/features/templates/components/carousel-cards-field";
import { TokenHighlightInput } from "@/features/templates/components/token-highlight";
import { useChannelAccounts } from "@/features/channels/contexts/channel-accounts-context";
import {
  recentlyUsedTemplates,
  templateHasLabel,
  templateLabelVocabulary,
  templateLabelsMatchQuery,
} from "@/features/templates/lib/template-labels";

/** Result of POST /api/broadcasts/preview-missing — recipients whose template
 *  variables would resolve to empty (missing field, no default) and be rejected
 *  by WhatsApp. Drives the pre-send warning. */
type MissingFieldsPreview = {
  total: number;
  sampled: boolean;
  affectedCount: number;
  missing: Array<{
    location: "body" | "header";
    position: number;
    fieldLabel: string | null;
    missingCount: number;
  }>;
};

/**
 * New broadcast wizard.
 *
 * One-page form rather than a multi-step navigator — agents see audience,
 * template, and preview all at once and can ping-pong without losing state.
 * Sections collapse to summaries once filled so the active step gets focus.
 *
 *   1. Audience: pick contacts or "all"
 *   2. Template: search + select from the team's approved templates
 *   3. Variables: fill {{N}} placeholders (same for all recipients in v1)
 *   4. Review + Send
 */

export function NewBroadcastForm({
  totalContactCount,
  initialContactLabels,
  initialTemplates = [],
  tags,
  fieldDefinitions,
  stages,
  groups: initialGroups,
  hasWabaId,
  preselectedContactIds,
  preselectedTagIds,
  preselectedGroupId,
  preselectAllAudience = false,
  cloneTemplateId = null,
  cloneBodyVars = null,
  cloneHeaderVar = null,
  cloneKind = null,
  cloneBodyText = null,
  cloneChannel = null,
  cloneCampaignName = null,
  initialChannel = null,
  teamMembers = [],
  assignmentPolicies = [],
}: {
  totalContactCount: number;
  /** Active roster + saved routing policies, for the campaign-assignment step. */
  teamMembers?: Array<{ id: string; name: string }>;
  assignmentPolicies?: Array<{ id: string; name: string; isDefault: boolean }>;
  initialContactLabels: ContactLabel[];
  /** SSR-seeded approved templates so the Template step isn't blank-then-spinner
   *  on first paint. The form still re-fetches from the client (and offers a
   *  manual Meta refresh) for freshness. */
  initialTemplates?: TemplateDto[];
  tags: Tag[];
  fieldDefinitions: ContactFieldDefinition[];
  stages: ContactStage[];
  groups: AudienceGroupDto[];
  hasWabaId: boolean;
  preselectedContactIds: string[];
  preselectedTagIds: string[];
  preselectedGroupId: string | null;
  /** Clone of an "all contacts" broadcast — open the form in All-contacts mode. */
  preselectAllAudience?: boolean;
  /** Clone prefill (from `?from=<id>`) — select this template + fill vars. */
  cloneTemplateId?: string | null;
  cloneBodyVars?: string[] | null;
  cloneHeaderVar?: string | null;
  /** Clone of a freeform broadcast — reopen in the same message mode, channel,
   *  and body instead of an empty WhatsApp-template composer. A legacy
   *  "customer" (People / best channel — mode removed 2026-07-27) clone
   *  reopens as freeform: the body carries over, the operator picks the
   *  channel. */
  cloneKind?: "template" | "freeform" | "customer" | null;
  cloneBodyText?: string | null;
  cloneChannel?: string | null;
  /** Clone's campaign — a duplicate is usually that campaign's NEXT send. */
  cloneCampaignName?: string | null;
  /** `?channel=` from the channel-scoped Outreach nav — which channel to open on. */
  initialChannel?: string | null;
}) {
  const router = useRouter();
  const { confirm, confirmDialog } = useConfirm();

  // Local copy so a "save as group" from the custom builder can append the new
  // group and select it without a round-trip.
  const [groups, setGroups] = useState<AudienceGroupDto[]>(initialGroups);

  // Pre-fill audience from the URL the agent arrived from. A groupId lands on
  // "saved group"; preselected tags/contacts (from the contacts page) land on
  // the custom builder pre-loaded. With no preselection we default to "all"
  // (the explicit mode picker is right there) rather than dropping the agent
  // into the highest-friction contact-by-contact builder.
  const [audience, setAudience] = useState<AudienceState>(() => {
    if (preselectAllAudience) {
      return {
        mode: "all",
        selectedIds: [],
        selectedTagIds: [],
        selectedFieldFilters: [],
        selectedGroupId: null,
      };
    }
    if (preselectedGroupId) {
      return {
        mode: "group",
        selectedIds: [],
        selectedTagIds: [],
        selectedFieldFilters: [],
        selectedGroupId: preselectedGroupId,
      };
    }
    if (preselectedTagIds.length > 0 || preselectedContactIds.length > 0) {
      return {
        mode: "custom",
        selectedIds: preselectedContactIds,
        selectedTagIds: preselectedTagIds,
        selectedFieldFilters: [],
        selectedGroupId: null,
      };
    }
    return {
      mode: "all",
      selectedIds: [],
      selectedTagIds: [],
      selectedFieldFilters: [],
      selectedGroupId: null,
    };
  });
  const [templates, setTemplates] = useState<TemplateDto[]>(initialTemplates);
  // Only block the Template step on the very first fetch when nothing was
  // SSR-seeded — a seeded list paints immediately and the background refresh
  // below swaps in fresh data without a spinner flash.
  const [templatesLoading, setTemplatesLoading] = useState(
    initialTemplates.length === 0,
  );
  const [templatesSyncing, setTemplatesSyncing] = useState(false);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  // Message type:
  //  - template: approved WhatsApp template (reaches contacts any time).
  //  - freeform: plain text to ONE social channel's in-window contacts.
  // A broadcast is strictly single-channel: the omnichannel "customer"
  // (People / best channel) mode was removed 2026-07-27; a legacy clone of one
  // reopens as freeform so its body carries over.
  const [messageKind, setMessageKind] = useState<"template" | "freeform">(
    cloneKind === "customer"
      ? "freeform"
      : cloneKind ??
          // `?channel=` from the channel-scoped Outreach nav. A social channel
          // means free-form (neither has templates); WhatsApp and anything
          // unrecognized fall back to the template composer.
          (initialChannel === "messenger" || initialChannel === "instagram"
            ? "freeform"
            : "template"),
  );
  const [freeformChannel, setFreeformChannel] = useState<"messenger" | "instagram">(
    cloneChannel === "instagram" || initialChannel === "instagram"
      ? "instagram"
      : "messenger",
  );
  const [freeformBody, setFreeformBody] = useState(cloneBodyText ?? "");
  /**
   * The ACCOUNT this campaign sends from — a specific WhatsApp number, Page or
   * Instagram handle. Every account is a distinct sender identity to the
   * customer, so it scopes both the template catalogue (a template belongs to
   * one WhatsApp Business Account) and the audience.
   */
  const [accountId, setAccountId] = useState<string | null>(null);
  // Distinguishes "the operator has not picked yet" from "the operator chose ALL
  // ACCOUNTS", which are both `accountId === null`. Without it the default-account
  // effect below reads a deliberate fan-out choice as an empty state and
  // immediately resets it to one Page — the option would appear to do nothing.
  const [accountChosen, setAccountChosen] = useState(false);
  /**
   * Opt-in to reaching contacts who belong to the workspace's OTHER accounts on
   * this channel. Off by default: those customers have never messaged this
   * sender, so they'd see an unfamiliar number and their reply would open a
   * separate thread.
   */
  const [includeOtherAccounts, setIncludeOtherAccounts] = useState(false);
  // Honest failure state: a swallowed accounts fetch used to be visually
  // identical to a healthy single-account workspace (one channel button, no
  // "Send from" select, no message) while the send fell back to whatever the
  // server defaulted to. Say so instead.
  // The workspace's connected accounts, from the app-wide directory seeded in
  // the (app) layout — not a fifth client refetch of the same rows.
  //
  // `failed` is carried through the context on purpose. A swallowed accounts
  // fetch used to be visually identical to a healthy single-account workspace
  // (one channel button, no "Send from" select, no message) while the send fell
  // back to whatever the server defaulted to. A surface that picks a SENDER
  // must not present "we couldn't load your numbers" as "you have one number".
  const { all: accounts, failed: accountsLoadFailed } = useChannelAccounts();

  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [templateQuery, setTemplateQuery] = useState("");
  const [bodyVars, setBodyVars] = useState<string[]>([]);
  const [headerVar, setHeaderVar] = useState("");
  const [headerMedia, setHeaderMedia] = useState<{
    kind: "image" | "video" | "document";
    link: string;
    filename?: string;
  } | null>(null);
  const [cards, setCards] = useState<CarouselCardValue[]>([]);
  const [location, setLocation] = useState({
    latitude: "",
    longitude: "",
    name: "",
    address: "",
  });
  // `datetime-local` wall-clock string; converted to UNIX ms on submit.
  const [offerExpiresAt, setOfferExpiresAt] = useState("");
  // Values for TOP-LEVEL buttons, keyed `${index}:${subType}`.
  const [buttonVals, setButtonVals] = useState<Record<string, string>>({});
  const [headerMediaUploading, setHeaderMediaUploading] = useState(false);
  const [headerMediaError, setHeaderMediaError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  // Synchronous re-entrancy lock for submit() — guards the window between the
  // first click and the confirm modal mounting, where `sending` is still false.
  const submittingRef = useRef(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // Optional operator label + scheduling. `scheduleMode` toggles between
  // immediate send and a future datetime; `scheduledLocal` is the raw value
  // from a <input type="datetime-local"> (local wall-clock, no tz) which we
  // convert to an ISO string on submit.
  const [name, setName] = useState("");
  // CAMPAIGN this send belongs to. A campaign is usually several broadcasts —
  // one per channel, one per account, a re-send to non-openers — and the rollup
  // groups on this string EXACTLY, so the existing names are offered as a
  // datalist. Retyping "Spring Sale " with a stray space silently starts a
  // second campaign, which is the one mistake this field can make.
  const [campaignName, setCampaignName] = useState(cloneCampaignName ?? "");
  const [knownCampaigns, setKnownCampaigns] = useState<string[]>([]);
  const [assignment, setAssignment] = useState<CampaignAssignmentValue>(
    EMPTY_CAMPAIGN_ASSIGNMENT,
  );
  const [scheduleMode, setScheduleMode] = useState<"now" | "later">("now");
  const [scheduledLocal, setScheduledLocal] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);

  // Live custom-audience recipient count. The shared AudienceBuilder owns the
  // (debounced, server-resolved) count and mirrors it up via this callback so
  // the send summary + readiness gate stay in sync. Stable identity so the
  // builder's effect doesn't re-fire on every parent render.
  const [customCount, setCustomCount] = useState(0);
  // Track the builder's in-flight count too: while a recount is pending the
  // mirrored `customCount` is stale (holds the previous value), so the
  // readiness gate must not treat a custom audience as "done" mid-recount.
  const [customCountLoading, setCustomCountLoading] = useState(false);
  const handleCustomCount = useCallback((count: number, loading: boolean) => {
    setCustomCount(count);
    setCustomCountLoading(loading);
  }, []);

  // Save-as-group from the custom builder: add the new group locally and
  // switch the wizard onto it so it's the active (reusable) selection.
  const handleGroupSaved = useCallback((group: AudienceGroupDto) => {
    setGroups((cur) => (cur.some((g) => g.id === group.id) ? cur : [group, ...cur]));
    setAudience((cur) => ({ ...cur, mode: "group", selectedGroupId: group.id }));
  }, []);

  // -------------------------------------------------------------------------
  // Template fetch + sync
  // -------------------------------------------------------------------------
  const syncTemplates = useCallback(async () => {
    setTemplatesSyncing(true);
    setTemplatesError(null);
    try {
      // Scoped like the GET below: the response feeds the picker directly, so
      // an unscoped sync would swap in another WABA's catalogue after refresh.
      const res = await apiFetch(
        `/api/workspace/whatsapp/templates${
          accountId ? `?accountId=${encodeURIComponent(accountId)}` : ""
        }`,
        { method: "POST" },
      );
      const data = (await res.json()) as {
        templates?: TemplateDto[];
        error?: string;
        detail?: string;
      };
      if (!res.ok) {
        throw new Error(
          [data.error, data.detail].filter(Boolean).join(": ") ||
            `HTTP ${res.status}`,
        );
      }
      setTemplates(data.templates ?? []);
    } catch (err) {
      setTemplatesError(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setTemplatesSyncing(false);
    }
  }, [accountId]);

  // `background` skips the loading spinner — used for the mount refresh when a
  // server-seeded list is already on screen, so it freshens silently instead of
  // flashing a spinner over a list the user can already read.
  const loadTemplates = useCallback(
    async (background = false, forAccountId?: string | null) => {
      setTemplatesError(null);
      if (!background) setTemplatesLoading(true);
      try {
        // Scoped to the sending ACCOUNT: templates live on a WhatsApp Business
        // Account and can only go out on a number under that same WABA, so
        // offering the whole workspace's catalogue would let an operator pick
        // one Meta then rejects for every recipient.
        const res = await apiFetch(
          `/api/workspace/whatsapp/templates${
            forAccountId ? `?accountId=${encodeURIComponent(forAccountId)}` : ""
          }`,
        );
        if (!res.ok) throw new Error(await safeReadError(res));
        const data = (await res.json()) as {
          templates?: TemplateDto[];
          hasWabaId?: boolean;
        };
        setTemplates(data.templates ?? []);
        // Auto-sync from Meta if cache is empty and the WABA is set up — same
        // behavior as the inbox picker so first-time users see something.
        if ((data.templates ?? []).length === 0 && data.hasWabaId) {
          void syncTemplates();
        }
      } catch (err) {
        // A background-refresh failure is silent — the seeded list stays usable
        // and the manual Refresh button surfaces a hard error if the user asks.
        if (!background) {
          setTemplatesError(err instanceof Error ? err.message : "Failed to load");
        }
      } finally {
        if (!background) setTemplatesLoading(false);
      }
    },
    [syncTemplates],
  );

  useEffect(() => {
    // Seeded → freshen in the background (no spinner). Cold → normal load.
    // Re-runs when the sending account changes: the catalogue is per-WABA, so a
    // different number means a different (possibly disjoint) template list.
    void loadTemplates(initialTemplates.length > 0, accountId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadTemplates, accountId]);

  // Clone prefill (?from=<id>): once templates load, select the source's
  // template. The var-reset effect below then fills bodyVars/headerVar from the
  // clone values on its first run for that template (guarded by cloneAppliedRef
  // so a later manual template switch resets to binding tokens as usual).
  const cloneAppliedRef = useRef(false);
  useEffect(() => {
    if (cloneAppliedRef.current) return;
    if (!cloneTemplateId || templates.length === 0) return;
    if (templates.some((t) => t.id === cloneTemplateId)) {
      setSelectedTemplateId(cloneTemplateId);
    } else {
      // Template no longer exists / not approved — give up on clone, normal form.
      cloneAppliedRef.current = true;
    }
  }, [templates, cloneTemplateId]);

  // -------------------------------------------------------------------------
  // Derived state
  // -------------------------------------------------------------------------
  const selectedTemplate = useMemo(
    () => templates.find((t) => t.id === selectedTemplateId) ?? null,
    [templates, selectedTemplateId],
  );

  const components = useMemo<TemplateComponent[]>(() => {
    if (!selectedTemplate) return [];
    return Array.isArray(selectedTemplate.components)
      ? (selectedTemplate.components as TemplateComponent[])
      : [];
  }, [selectedTemplate]);

  const headerComp = components.find((c) => c.type === "HEADER");
  const footerComp = components.find((c) => c.type === "FOOTER");
  const buttonsComp = components.find((c) => c.type === "BUTTONS");

  // NAMED vs POSITIONAL comes from Meta's stored `parameter_format`, never from
  // a regex over the body: a positional template containing `{{order_id}}` as
  // literal copy would be misread, and the wrong wire shape fails every
  // recipient with Meta error 132000.
  const isNamedTemplate = selectedTemplate?.parameterFormat === "named";
  // Placeholder NAMES in first-appearance order — the order the runner zips
  // these values back against on the wire, so the inputs must be collected in
  // exactly this order too.
  const namedBodyVars = useMemo(
    () =>
      isNamedTemplate && selectedTemplate
        ? templateNamedPlaceholders(selectedTemplate.bodyText)
        : [],
    [isNamedTemplate, selectedTemplate],
  );
  const namedHeaderVar =
    isNamedTemplate && headerComp?.format === "TEXT" && headerComp.text
      ? templateNamedPlaceholders(headerComp.text)[0]
      : undefined;

  const bodyVarCount = !selectedTemplate
    ? 0
    : isNamedTemplate
      ? namedBodyVars.length
      : countPlaceholders(selectedTemplate.bodyText);
  const headerVarCount =
    headerComp?.format === "TEXT" && headerComp.text
      ? isNamedTemplate
        ? namedHeaderVar
          ? 1
          : 0
        : countPlaceholders(headerComp.text)
      : 0;
  // Carousel cards — campaign-level, since every recipient sees the same strip.
  const cardRequirements = useMemo(
    () => requiredCarouselCards(components),
    [components],
  );
  // A LOCATION header carries its whole pin at send time — campaign-level,
  // since a location template promotes one place to the whole audience.
  const needsLocation = headerComp?.format === "LOCATION";
  // TOP-LEVEL buttons that demand a send-time value (coupon code, URL suffix)
  // — campaign-level: one code / one suffix for every recipient.
  const buttonRequirements = useMemo(
    () => requiredTemplateButtonParams(components, selectedTemplate?.category),
    [components, selectedTemplate?.category],
  );
  // A countdown template needs ONE campaign-level expiry — the whole point of a
  // limited-time offer is a single shared deadline.
  const needsOfferExpiry = templateNeedsOfferExpiry(components);
  // IMAGE/VIDEO/DOCUMENT headers need one campaign media (reused for everyone).
  const headerMediaKind: "image" | "video" | "document" | null =
    headerComp?.format === "IMAGE"
      ? "image"
      : headerComp?.format === "VIDEO"
        ? "video"
        : headerComp?.format === "DOCUMENT"
          ? "document"
          : null;

  const uploadHeaderMedia = useCallback(async (file: File) => {
    setHeaderMediaError(null);
    setHeaderMediaUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await apiFetch("/api/messages/template-header-media", {
        method: "POST",
        body: fd,
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          detail?: string;
          error?: string;
        } | null;
        setHeaderMediaError(data?.detail ?? data?.error ?? "Upload failed");
        return;
      }
      const data = (await res.json()) as {
        link: string;
        kind: "image" | "video" | "document";
        filename?: string;
      };
      setHeaderMedia({ kind: data.kind, link: data.link, filename: data.filename });
    } catch {
      setHeaderMediaError("Upload failed — check your connection and try again.");
    } finally {
      setHeaderMediaUploading(false);
    }
  }, []);

  // Reset variable arrays whenever the chosen template changes. When the
  // template carries bindings, prefill each input with the matching token so
  // the agent sees the personalization upfront and can override.
  useEffect(() => {
    setHeaderMedia(null);
    setHeaderMediaError(null);
    // The card COUNT comes from the template, so switching templates reseeds
    // the strip rather than carrying the old one's cards over.
    setCards(emptyCarouselCards(cardRequirements));
    setLocation({ latitude: "", longitude: "", name: "", address: "" });
    setOfferExpiresAt("");
    setButtonVals({});
    if (!selectedTemplate) {
      setBodyVars(Array.from({ length: bodyVarCount }, () => ""));
      setHeaderVar("");
      return;
    }
    // Clone: on the FIRST reset for the cloned template, use the source's saved
    // values instead of binding tokens. One-shot — a later manual switch falls
    // through to the normal binding-token prefill.
    if (
      !cloneAppliedRef.current &&
      cloneTemplateId &&
      selectedTemplateId === cloneTemplateId
    ) {
      cloneAppliedRef.current = true;
      setBodyVars(
        Array.from({ length: bodyVarCount }, (_, i) => cloneBodyVars?.[i] ?? ""),
      );
      setHeaderVar(headerVarCount > 0 ? cloneHeaderVar ?? "" : "");
      return;
    }
    const bindings = parseVariableBindings(selectedTemplate.variableBindings as never);
    setBodyVars(
      Array.from({ length: bodyVarCount }, (_, i) => tokenForBinding(bindings.body[i])),
    );
    setHeaderVar(headerVarCount > 0 ? tokenForBinding(bindings.header) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTemplateId, bodyVarCount, headerVarCount, cardRequirements]);

  // The channel a template/freeform broadcast actually sends on. All/group
  // recipient counts must be scoped to it (a WhatsApp template can't reach a
  // Messenger-only contact).
  /**
   * The channel this campaign targets, as ONE value.
   *
   * `messageKind` conflated "what am I sending" with "where am I sending it".
   * The composer is channel-first — you pick WhatsApp / Messenger / Instagram
   * and everything downstream derives from that — so this is the single
   * selection and `messageKind` + `freeformChannel` are DERIVED from it.
   * Keeping the old state as the derivation target means every existing gate,
   * cap and count below is untouched.
   */
  const selectedChannel: "whatsapp" | "messenger" | "instagram" =
    messageKind === "template" ? "whatsapp" : freeformChannel;

  const setSelectedChannel = useCallback(
    (next: "whatsapp" | "messenger" | "instagram") => {
      if (next === "whatsapp") setMessageKind("template");
      else {
        setMessageKind("freeform");
        setFreeformChannel(next);
      }
      // The account and the template belong to the OLD channel — carrying either
      // across would bind the campaign to a sender that can't send it.
      setAccountId(null);
      // A different channel has different accounts, so a previous pick is
      // meaningless — fall back to that channel's default again.
      setAccountChosen(false);
      setIncludeOtherAccounts(false);
      setSelectedTemplateId(null);
    },
    [],
  );

  /** Connected accounts on the selected channel, default first. */
  const channelAccounts = useMemo(
    () => accounts.filter((a) => a.channel === selectedChannel && a.isActive),
    [accounts, selectedChannel],
  );

  const selectedAccount = useMemo(
    () => channelAccounts.find((a) => a.id === accountId) ?? null,
    [channelAccounts, accountId],
  );

  /** Which channels the workspace can actually broadcast on. */
  const connectedChannels = useMemo(() => {
    const live = (["whatsapp", "messenger", "instagram"] as const).filter((ch) =>
      accounts.some((a) => a.channel === ch && a.isActive),
    );
    // NEVER render an empty channel row. `accounts` is empty both before the
    // fetch resolves and if it fails outright, and an empty list would
    // silently remove the ability to send a template at all. Falling back to
    // the current selection keeps the composer usable and lets the server be
    // the authority on connectivity (it already rejects an unknown/inactive
    // account).
    if (live.length > 0) return live;
    return [selectedChannel] as const;
  }, [accounts, selectedChannel]);

  // Default to the channel's default account as soon as accounts land, so the
  // template list and the audience are scoped from the first render rather than
  // silently defaulting server-side.
  useEffect(() => {
    if (accountChosen) return;
    if (accountId && channelAccounts.some((a) => a.id === accountId)) return;
    const fallback = channelAccounts.find((a) => a.isDefault) ?? channelAccounts[0];
    setAccountId(fallback?.id ?? null);
  }, [selectedChannel, channelAccounts, accountId, accountChosen]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch("/api/reports/campaigns");
        if (!res.ok) return;
        const body = (await res.json()) as { campaigns?: Array<{ campaignName: string }> };
        if (!cancelled) setKnownCampaigns((body.campaigns ?? []).map((c) => c.campaignName));
      } catch {
        // Suggestions are a convenience, not a requirement — a failure here must
        // not block composing a broadcast.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const countChannel: "whatsapp" | "messenger" | "instagram" =
    messageKind === "template" ? "whatsapp" : freeformChannel;

  // Per-target text cap for the freeform composer, mirroring the server's
  // cap gate (broadcasts.service create): the fixed freeform channel caps
  // against that channel (Messenger 2000 / Instagram 1000). Static 2000 let a
  // 1001–2000 char Instagram body pass the composer and 400 at create.
  const freeformCapChannels = [freeformChannel];
  const freeformMaxChars = Math.min(
    ...freeformCapChannels.map((c) => CHANNEL_CAPABILITIES[c].messageTextMaxChars),
  );
  // Instagram's cap is UTF-8 BYTES, not chars (textLimitIsBytes) — match the
  // server's byte-aware checkTextCap so a multibyte body can't pass the composer
  // and 400 at create. If any candidate channel counts bytes, measure bytes.
  const freeformByteMode = freeformCapChannels.some(
    (c) => CHANNEL_CAPABILITIES[c].textLimitIsBytes === true,
  );
  // Measure the TRIMMED body — create sends freeformBody.trim() and the server
  // measures that, so counting the raw value would wrongly block a valid body
  // padded with whitespace.
  const freeformTrimmed = freeformBody.trim();
  const freeformTextSize = freeformByteMode
    ? new TextEncoder().encode(freeformTrimmed).length
    : freeformTrimmed.length;
  const freeformOverCap = freeformTextSize > freeformMaxChars;

  const scopedGroup =
    audience.mode === "group"
      ? groups.find((x) => x.id === audience.selectedGroupId) ?? null
      : null;

  // Channel- AND account-scoped server counts for the all/group audiences
  // (custom mode's count comes from the builder). The account dimension is
  // what makes the include-other-accounts checkbox HONEST: ticking it widens
  // the real audience, so the number on screen must widen with it — and the
  // messaging-cap warning below compares against this same figure.
  const allCount = useAudienceCount([], [], {
    all: audience.mode === "all" && !!countChannel,
    channel: countChannel,
    initial: totalContactCount,
    accountId,
    includeOtherAccounts,
  });
  const groupCount = useAudienceCount(
    countChannel && scopedGroup ? scopedGroup.tagIds : [],
    countChannel && scopedGroup ? scopedGroup.contactIds : [],
    {
      channel: countChannel,
      accountId,
      includeOtherAccounts,
      // The group's stored field filters MUST ride the count: the server
      // resolves recipients WITH them (and the preview below passes them), so
      // omitting them here showed a ~tags-wide number the operator confirmed
      // a billed send against — e.g. 5,000 where the filtered audience was
      // 800 (audit 2026-08-10).
      ...(countChannel && scopedGroup?.fieldFilters.length
        ? { fieldFilters: scopedGroup.fieldFilters }
        : {}),
    },
  );

  // Recipient count for the active mode. Custom mode's count comes from the
  // shared builder (server-resolved union). All/group show the raw all-channel
  // total until the channel-scoped server count actually RESOLVES — mid-flight
  // and on a failed fetch the hook's `count` is a stale 0, which would wrongly
  // read as "no recipients" and disable Send for a valid audience.
  const audienceCount = useMemo(() => {
    if (audience.mode === "custom") return customCount;
    if (audience.mode === "all") {
      if (!countChannel) return totalContactCount;
      return allCount.resolved ? allCount.count : totalContactCount;
    }
    // group
    if (!scopedGroup) return 0;
    if (!countChannel) return scopedGroup.memberCount;
    return groupCount.resolved ? groupCount.count : scopedGroup.memberCount;
  }, [
    audience,
    totalContactCount,
    customCount,
    countChannel,
    scopedGroup,
    allCount.resolved,
    allCount.count,
    groupCount.resolved,
    groupCount.count,
  ]);

  const audienceDone =
    audienceCount > 0 && !(audience.mode === "custom" && customCountLoading);

  // What "Preview recipients" resolves against — the same { tagIds, contactIds }
  // union the server expands. Null for "all" (no point) and for an empty
  // selection. Group mode reuses the group dto's tag + manual snapshot
  // (`scopedGroup`, resolved above for the recipient count).
  // Scoped by `countChannel` + the "Send from" account for the same reason
  // the count is: the send drops off-channel and other-account contacts, so
  // previewing them as recipients is a lie.
  const previewPayload: {
    tagIds: string[];
    contactIds: string[];
    fieldFilters?: ContactFieldFilter[];
    channel?: "whatsapp" | "messenger" | "instagram";
    accountId?: string | null;
    includeOtherAccounts?: boolean;
  } | null = (() => {
    const scope = {
      ...(countChannel ? { channel: countChannel } : {}),
      ...(accountId ? { accountId } : {}),
      ...(includeOtherAccounts && !isAccountScopedIdentity(selectedChannel)
        ? { includeOtherAccounts: true }
        : {}),
    };
    if (
      audience.mode === "custom" &&
      (audience.selectedTagIds.length > 0 || audience.selectedIds.length > 0)
    ) {
      return {
        tagIds: audience.selectedTagIds,
        contactIds: audience.selectedIds,
        ...(audience.selectedFieldFilters.length
          ? { fieldFilters: audience.selectedFieldFilters }
          : {}),
        ...scope,
      };
    }
    if (audience.mode === "group" && scopedGroup) {
      return {
        tagIds: scopedGroup.tagIds,
        contactIds: scopedGroup.contactIds,
        // The group's STORED predicates — the preview must narrow like the
        // send will.
        ...(scopedGroup.fieldFilters.length
          ? { fieldFilters: scopedGroup.fieldFilters }
          : {}),
        ...scope,
      };
    }
    return null;
  })();
  const previewSubtitle =
    audience.mode === "group"
      ? `Saved group: ${scopedGroup?.name ?? "—"}`
      : `${audience.selectedTagIds.length} tag${audience.selectedTagIds.length === 1 ? "" : "s"} · ${audience.selectedIds.length} hand-picked`;

  // `null` when unset OR already past — both block the send.
  const offerExpiryMs = (() => {
    if (!offerExpiresAt) return null;
    const ms = new Date(offerExpiresAt).getTime();
    return Number.isFinite(ms) && ms > Date.now() ? ms : null;
  })();

  const templateDone = selectedTemplate !== null;
  const variablesDone =
    templateDone &&
    bodyVars.every((v) => v.trim().length > 0) &&
    (headerVarCount === 0 || headerVar.trim().length > 0) &&
    (headerMediaKind === null || headerMedia !== null) &&
    // Only the coordinates are required — name and address are optional labels.
    (!needsLocation ||
      (location.latitude.trim() !== "" && location.longitude.trim() !== "")) &&
    (!needsOfferExpiry || offerExpiryMs !== null) &&
    (cardRequirements.length === 0 ||
      carouselCardsComplete(cardRequirements, cards)) &&
    buttonRequirements.every(
      (b) => (buttonVals[`${b.index}:${b.subType}`] ?? "").trim() !== "",
    ) &&
    // Don't let the broadcast fire while the header media is still uploading —
    // otherwise it sends with a stale/empty link the moment a prior upload
    // populated `headerMedia` but the current pick hasn't finished.
    !headerMediaUploading;
  const freeformDone = freeformBody.trim().length > 0 && !freeformOverCap;
  const readyToSend =
    audienceDone &&
    (messageKind === "template" ? templateDone && variablesDone : freeformDone);
  // The FIRST unmet gate, by step order, so the disabled Send button explains
  // itself. "Complete every step" named nothing — and the Variables step is
  // conditionally rendered, so its gap could be literally off-screen.
  const nextGateHint = !audienceDone
    ? "Pick an audience (step 2) to enable sending."
    : messageKind === "template"
      ? !templateDone
        ? "Pick a template (step 3) to enable sending."
        : "Fill every template variable (step 4) to enable sending."
      : freeformOverCap
        ? "Shorten the message to fit the channel's limit."
        : "Write the message (step 3) to enable sending.";

  // ── Pre-send warning ──────────────────────────────────────────────────────
  // Ask the server (read-only) how many recipients would resolve a template
  // variable to EMPTY (a mapped field like email is missing, no default) and be
  // rejected by WhatsApp — so the agent finds out BEFORE sending, not from a
  // wall of failed rows after. Same audience shape the create call sends.
  const audiencePayload = useMemo(() => {
    if (audience.mode === "all") return { mode: "all" as const };
    if (audience.mode === "group")
      return { mode: "group" as const, groupId: audience.selectedGroupId };
    return {
      mode: "custom" as const,
      tagIds: audience.selectedTagIds,
      contactIds: audience.selectedIds,
      ...(audience.selectedFieldFilters.length
        ? { fieldFilters: audience.selectedFieldFilters }
        : {}),
    };
  }, [audience]);
  const [missingPreview, setMissingPreview] = useState<MissingFieldsPreview | null>(
    null,
  );
  useEffect(() => {
    // Only relevant once a template with variables + a non-empty audience exist.
    if (!selectedTemplate || (bodyVarCount === 0 && headerVarCount === 0)) {
      setMissingPreview(null);
      return;
    }
    const hasAudience =
      audience.mode === "all" ||
      (audience.mode === "group" && !!audience.selectedGroupId) ||
      (audience.mode === "custom" &&
        (audience.selectedTagIds.length > 0 || audience.selectedIds.length > 0));
    if (!hasAudience) {
      setMissingPreview(null);
      return;
    }
    const controller = new AbortController();
    const t = window.setTimeout(() => {
      void (async () => {
        try {
          const res = await apiFetch("/api/broadcasts/preview-missing", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              templateId: selectedTemplate.id,
              audience: audiencePayload,
              variables: {
                body: bodyVars,
                ...(headerVarCount > 0 ? { header: headerVar } : {}),
              },
            }),
            signal: controller.signal,
          });
          if (!res.ok) return;
          setMissingPreview((await res.json()) as MissingFieldsPreview);
        } catch {
          // Aborted (newer edit) or transient — keep the prior state, no churn.
        }
      })();
    }, 500);
    return () => {
      controller.abort();
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTemplate?.id, audiencePayload, bodyVars, headerVar, bodyVarCount, headerVarCount]);

  // WhatsApp messaging-limit snapshot for the pre-send eligibility hint,
  // scoped to the SELECTED "Send from" account and refetched when it changes —
  // quality and tier are per-number, so the default number's figures would
  // pass/fail the gate against the wrong account. (The 24h budget itself is
  // portfolio-shared: two numbers in one portfolio show the same budget, by
  // design.) The hard gate lives server-side in create() with the same numbers.
  const [messagingHealth, setMessagingHealth] = useState<{
    messagingTier: string | null;
    messagingDailyCap: number | null;
    qualityRating: string | null;
    hasSnapshot: boolean;
    recentUniqueRecipients: number | null;
    remainingDailyBudget: number | null;
    /** How many numbers share this budget — drives the copy's framing. */
    portfolioAccountCount?: number;
    /** ACTIVE utility-template enforcement on the WABA (server filters
     *  expired): sends of UTILITY templates over Meta's cap are rejected. */
    utilityRestrictionType?: string | null;
    utilityRestrictedUntil?: string | null;
    /** ACTIVE policy/spam messaging enforcement on the WABA (server filters
     *  expired): business-initiated sends — this whole surface — are rejected
     *  by Meta for the duration. Null until = indefinite (lock/ban). */
    bizMessagingRestrictionType?: string | null;
    bizMessagingRestrictedUntil?: string | null;
  } | null>(null);
  useEffect(() => {
    // Only WhatsApp campaigns are tier-gated; don't burn a request per social
    // account switch for a hint that never renders.
    if (selectedChannel !== "whatsapp") return;
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await apiFetch(
          `/api/broadcasts/messaging-health${
            accountId ? `?accountId=${encodeURIComponent(accountId)}` : ""
          }`,
          { signal: controller.signal },
        );
        if (!res.ok) return;
        if (!controller.signal.aborted) setMessagingHealth(await res.json());
      } catch {
        // Advisory only — a fetch failure just hides the hint.
      }
    })();
    return () => {
      controller.abort();
    };
  }, [selectedChannel, accountId]);

  // Eligibility hint: template sends only (WhatsApp tier is a template concept).
  // Over-cap → a blocking-styled warning (server enforces); RED quality → advisory.
  const eligibilityWarning = useMemo<
    { level: "error" | "warn"; text: string } | null
  >(() => {
    if (messageKind !== "template" || !messagingHealth) return null;
    // Policy/spam enforcement outranks the budget math below: while a
    // messaging restriction is active, Meta rejects EVERY business-initiated
    // send, so no amount of remaining budget makes this campaign deliverable.
    // Advisory (the server doesn't hard-block — Meta is the enforcement
    // authority and our copy of the restriction could be stale), but styled
    // as the error it will become. SCHEDULE_FOR_DISABLE still sends until the
    // ban date, so it warns instead of reading as an active block.
    const bizRestriction = messagingHealth.bizMessagingRestrictionType;
    if (bizRestriction === "WABA_BAN_SCHEDULE_FOR_DISABLE") {
      return {
        level: "warn",
        text:
          "Meta has scheduled this WhatsApp Business Account to be disabled. Sends " +
          "still work until the ban date, but unless the decision is reversed the " +
          "account stops sending entirely — appeal in Meta Business Support Home " +
          "before investing in new campaigns.",
      };
    }
    if (bizRestriction) {
      const until = messagingHealth.bizMessagingRestrictedUntil
        ? ` until ${new Date(messagingHealth.bizMessagingRestrictedUntil).toLocaleDateString()}`
        : " with no end date (it stands until Meta reverses it)";
      return {
        level: "error",
        text:
          `Meta has blocked business-initiated messages on this WhatsApp Business ` +
          `Account${until} — every send in this campaign would be rejected. This is ` +
          `Meta's enforcement for policy or spam violations; check Meta Business ` +
          `Support Home for the violation and any appeal before launching.`,
      };
    }
    const cap = messagingHealth.messagingDailyCap;
    const tier = messagingHealth.messagingTier ?? "current";
    // The 24h budget is BUSINESS-PORTFOLIO-scoped (shared by every number in
    // it, per Meta's 2025-10-07 change) — with several numbers in the
    // portfolio, "this number has already messaged…" would imply a per-number
    // budget that doesn't exist and send the operator to switch numbers for
    // relief they won't get.
    const shared = (messagingHealth.portfolioAccountCount ?? 1) > 1;
    const subject = shared ? "Your WhatsApp numbers' shared business portfolio" : "This number";
    if (cap !== null && audienceCount > cap) {
      return {
        level: "error",
        text:
          `${subject} can message ${cap.toLocaleString()} unique customers per 24h ` +
          `(${tier} tier), but this audience is ` +
          `${audienceCount.toLocaleString()}. Meta will reject the excess — split the send ` +
          `across days or raise your messaging limit with Meta first.`,
      };
    }
    // The audience fits the cap outright but not what's LEFT of it. The cap is
    // a rolling-24h budget shared across every send from the portfolio's
    // numbers, so earlier campaigns today can leave a perfectly reasonable
    // audience unsendable.
    const remaining = messagingHealth.remainingDailyBudget;
    const used = messagingHealth.recentUniqueRecipients;
    if (cap !== null && remaining !== null && used !== null && audienceCount > remaining) {
      return {
        level: "error",
        text:
          `${subject} has already messaged ${used.toLocaleString()} unique customers in the ` +
          `last 24h, leaving ${remaining.toLocaleString()} of ${
            shared ? "the shared" : "its"
          } ${cap.toLocaleString()} ` +
          `${tier}-tier allowance. This audience is ${audienceCount.toLocaleString()}, so Meta ` +
          `would reject about ${(audienceCount - remaining).toLocaleString()} of them. Wait for ` +
          `the window to roll over, or reduce the audience.`,
      };
    }
    // Template-categorization enforcement: Meta rejects UTILITY sends over a
    // cap we can't see (rate-limit) or has recategorized the WABA's utility
    // templates outright. Marketing/authentication sends are unaffected, so
    // this only fires when the SELECTED template is a utility one.
    if (
      messagingHealth.utilityRestrictionType &&
      selectedTemplate?.category === "utility"
    ) {
      const until = messagingHealth.utilityRestrictedUntil
        ? ` (until ${new Date(messagingHealth.utilityRestrictedUntil).toLocaleDateString()})`
        : "";
      return {
        level: "warn",
        text:
          messagingHealth.utilityRestrictionType === "RATE_LIMITED_UTILITY_TEMPLATE_MESSAGING"
            ? `Meta has rate-limited UTILITY sends on this WhatsApp Business Account${until} ` +
              `over template-categorization issues — utility messages beyond Meta's cap will be ` +
              `rejected. Marketing and authentication sends are unaffected.`
            : `Meta has restricted UTILITY templates on this WhatsApp Business Account${until} ` +
              `over template-categorization issues — this template may have been recategorized ` +
              `to marketing (billed differently), and new utility templates are blocked.`,
      };
    }
    if (messagingHealth.qualityRating === "RED") {
      return {
        level: "warn",
        text:
          "This number's quality rating is RED — a large marketing blast now risks a " +
          "further downgrade or block. Consider warming up with a smaller send first.",
      };
    }
    // Per-TEMPLATE quality (distinct from the number's rating above). RED means
    // Meta may pause or disable the template soon — and a mid-flight pause
    // auto-halts the campaign, so surface it BEFORE launch, not from the
    // failure report.
    if (selectedTemplate?.qualityScore?.toUpperCase() === "RED") {
      return {
        level: "warn",
        text:
          "This template's quality rating is RED (low) — Meta may pause or disable it " +
          "soon, which would halt this campaign mid-send. Consider a different template, " +
          "or address the feedback driving the rating first.",
      };
    }
    return null;
  }, [
    messageKind,
    messagingHealth,
    audienceCount,
    selectedTemplate?.category,
    selectedTemplate?.qualityScore,
  ]);

  const filteredTemplates = useMemo(() => {
    const q = templateQuery.trim().toLowerCase();
    if (!q) return templates;
    return templates.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.bodyText.toLowerCase().includes(q) ||
        t.language.toLowerCase().includes(q) ||
        templateLabelsMatchQuery(t, q),
    );
  }, [templates, templateQuery]);

  // -------------------------------------------------------------------------
  // Submit
  // -------------------------------------------------------------------------
  async function submit() {
    if (!readyToSend) return;
    if (messageKind === "template" && !selectedTemplate) return;
    const isFreeform = messageKind === "freeform";
    const usesBody = isFreeform;
    const countLabel = `${audienceCount} recipient${audienceCount === 1 ? "" : "s"}`;
    // Re-entrancy lock. `sending` (the button-disable signal) isn't set until
    // AFTER the destructive confirm resolves, so a fast double-click / Enter
    // before the confirm modal mounts could fire submit() twice and create two
    // broadcasts to the WHOLE audience — the highest-blast-radius action in the
    // product. This synchronous ref closes that window; the finally releases it
    // on every cancel/validation/error path and holds it through nav on success.
    if (submittingRef.current) return;
    submittingRef.current = true;
    let navigating = false;
    try {
      // Resolve scheduling. datetime-local has no timezone — `new Date(local)`
      // interprets it in the browser's local zone, which is what the user means
      // ("send at 3pm" = 3pm where they are). Guard against a past time.
      let scheduledAtIso: string | null = null;
      if (scheduleMode === "later") {
        if (!scheduledLocal) {
          setSendError("Pick a date and time, or switch to Send now.");
          return;
        }
        const when = new Date(scheduledLocal);
        if (Number.isNaN(when.getTime())) {
          setSendError("That date/time isn't valid.");
          return;
        }
        if (when.getTime() <= Date.now()) {
          setSendError("Scheduled time must be in the future.");
          return;
        }
        scheduledAtIso = when.toISOString();
      }

      // Highest-blast-radius action in the product — an immediate "Send now"
      // dispatches irreversible, customer-visible WhatsApp template messages to
      // the WHOLE audience on one click (and, post-send, can't be stopped). Gate
      // it behind a destructive confirm, matching the friction the product
      // already requires to delete a single contact. Scheduling stays one-click:
      // a scheduled broadcast can be canceled/deleted before it fires.
      if (!scheduledAtIso) {
        // Resolve a one-line preview of the body the same way the live
        // PreviewBubble does (renderPlaceholders + resolveFieldTokens over the
        // sample contact) so the confirm shows exactly what the agent saw, then
        // truncate it to keep the dialog body one line.
        const resolvedBody = usesBody
          ? freeformBody.replace(/\s+/g, " ").trim()
          : renderPlaceholders(
              selectedTemplate!.bodyText,
              bodyVars.map((v) => resolveFieldTokens(v, SAMPLE_CONTACT)),
            )
              .replace(/\s+/g, " ")
              .trim();
        const bodyPreview = truncate(resolvedBody, 90);
        // Single source of truth for channel display names — a local ternary here
        // silently mislabels the moment a fourth channel goes live.
        const channelLabel = isFreeform
          ? CHANNEL_LABEL[freeformChannel]
          : CHANNEL_LABEL.whatsapp;
        // Name the SENDER too — with several accounts on a channel, "over
        // WhatsApp" alone leaves the most important fact of the send implicit.
        const senderLabel = selectedAccount ? ` from ${selectedAccount.name}` : "";
        const ok = await confirm({
          title: `Send to ${countLabel} now?`,
          description:
            (usesBody
              ? `Sending a message to ${countLabel}`
              : `Sending «${selectedTemplate!.name}» to ${countLabel}`) +
            (bodyPreview ? `: “${bodyPreview}”` : "") +
            `. This sends immediately over ${channelLabel}${senderLabel} and can't be undone once recipients start receiving it.` +
            (isFreeform
              ? " Only contacts inside their messaging window will receive it."
              : ""),
          confirmLabel: "Send now",
          destructive: true,
        });
        if (!ok) return;
      }

      setSendError(null);
      setSending(true);
      try {
        const res = await apiFetch("/api/broadcasts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...(isFreeform
              ? { kind: "freeform", channel: freeformChannel, bodyText: freeformBody.trim() }
              : {
                  templateId: selectedTemplate!.id,
                  variables: {
                    body: bodyVars,
                    ...(headerVarCount > 0 ? { header: headerVar } : {}),
                    ...(headerMedia ? { headerMedia } : {}),
                    ...(needsLocation ? { headerLocation: location } : {}),
                    // Flattened for the campaign row: one card = one media plus
                    // its values, exactly what the runner replays per recipient.
                    ...(cardRequirements.length > 0
                      ? {
                          cards: cards.map((c) => ({
                            kind: c.headerMedia.kind,
                            link: c.headerMedia.link,
                            ...(c.body ? { body: c.body } : {}),
                            ...(c.buttons ? { buttons: c.buttons } : {}),
                          })),
                        }
                      : {}),
                    ...(offerExpiryMs !== null
                      ? { limitedTimeOfferExpiresAtMs: offerExpiryMs }
                      : {}),
                    // Campaign-level button values (coupon code / URL suffix).
                    ...(buttonRequirements.length > 0
                      ? {
                          buttons: buttonRequirements.map((b) => ({
                            index: b.index,
                            subType: b.subType,
                            text: (buttonVals[`${b.index}:${b.subType}`] ?? "").trim(),
                          })),
                        }
                      : {}),
                  },
                }),
            // Bind the campaign to the chosen sender.
            ...(accountId ? { channelConnectionId: accountId } : {}),
            // Trimmed so a stray space can't fork the rollup into two campaigns.
            ...(campaignName.trim() ? { campaignName: campaignName.trim() } : {}),
            ...(includeOtherAccounts && !isAccountScopedIdentity(selectedChannel)
        ? { includeOtherAccounts: true }
        : {}),
            ...(name.trim() ? { name: name.trim() } : {}),
            ...(scheduledAtIso ? { scheduledAt: scheduledAtIso } : {}),
            // Omitted entirely when the campaign assigns nobody, so the request
            // shape is unchanged for every existing caller.
            ...(assignment.mode !== "none"
              ? {
                  assignment: {
                    mode: assignment.mode,
                    userId: assignment.userId,
                    policyId: assignment.policyId,
                    split: assignment.split,
                    leftover: assignment.leftover,
                    trigger: assignment.trigger,
                    overwrite: assignment.overwrite,
                  },
                }
              : {}),
            audience:
              audience.mode === "all"
                ? { mode: "all" }
                : audience.mode === "group"
                  ? { mode: "group", groupId: audience.selectedGroupId }
                  : {
                      mode: "custom",
                      tagIds: audience.selectedTagIds,
                      contactIds: audience.selectedIds,
                      ...(audience.selectedFieldFilters.length
                        ? { fieldFilters: audience.selectedFieldFilters }
                        : {}),
                    },
          }),
        });
        if (!res.ok) {
          throw new Error(await safeReadError(res));
        }
        const data = (await res.json()) as { broadcastId?: string };
        if (!data.broadcastId) throw new Error("No broadcast id in response");
        toast.success(
          scheduledAtIso
            ? `Broadcast scheduled for ${countLabel}`
            : `Broadcast sending to ${countLabel}`,
        );
        navigating = true;
        router.push(`/broadcasts/${data.broadcastId}`);
      } catch (err) {
        setSendError(err instanceof Error ? err.message : "Failed to send");
        setSending(false);
      }
    } finally {
      // Hold the lock through navigation on success (the form unmounts);
      // release on every other path so a corrected error can be re-submitted.
      if (!navigating) submittingRef.current = false;
    }
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6 md:py-8">
      <header className="flex flex-col gap-1">
        <Link
          href="/broadcasts"
          className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Back to broadcasts
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">New broadcast</h1>
        <p className="text-sm text-muted-foreground">
          Send one message to many recipients at once — the same content and the
          same variable values for everyone.
        </p>
      </header>

      {/* Channel & sender. Deliberately the FIRST decision — rendered first,
          numbered first: a campaign is WhatsApp OR Messenger OR Instagram,
          never a mix, and everything after this — templates, audience counts,
          message type, limits — derives from it. */}
      <StepCard
        index={1}
        title="Channel"
        summary={`${CHANNEL_LABEL[selectedChannel]}${
          selectedAccount ? ` · ${selectedAccount.name}` : ""
        }`}
        // Done once the sender is actually resolved. Hardcoded `done` showed a
        // green check from first paint — before accounts had even loaded — and
        // the step numeral "1" never rendered at all. Empty directory (fetch
        // failed / mid-onboarding) counts as done: there is nothing to pick.
        done={channelAccounts.length === 0 || Boolean(selectedAccount)}
      >
        <div className="flex flex-col gap-3">
          {/* One connected channel needs no picker — same reasoning as the
              single-account "Send from" select below. The summary already
              names it. */}
          {connectedChannels.length > 1 && (
            <div className="flex flex-wrap gap-2">
              {connectedChannels.map((ch) => (
                <button
                  key={ch}
                  type="button"
                  onClick={() => setSelectedChannel(ch)}
                  className={
                    "flex-1 whitespace-nowrap rounded-md border px-3 py-2 text-sm font-medium transition " +
                    (selectedChannel === ch
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border bg-muted/20 text-muted-foreground hover:text-foreground")
                  }
                >
                  {CHANNEL_LABEL[ch]}
                </button>
              ))}
            </div>
          )}

          {accountsLoadFailed && (
            <p className="text-2xs leading-relaxed text-warning-fg">
              Couldn&apos;t load your connected accounts — the campaign will go
              out on {CHANNEL_LABEL[selectedChannel]}&apos;s default account.
              Reload the page to pick a specific one.
            </p>
          )}

          {/* A single-account channel needs no picker — showing one is
              noise. The account is still bound on the wire. */}
          {channelAccounts.length > 1 && (
            <label className="flex flex-col gap-1">
              <span className="text-2xs font-medium text-muted-foreground">
                Send from
              </span>
              <select
                value={accountId ?? ""}
                onChange={(e) => {
                  setAccountChosen(true);
                  setAccountId(e.target.value || null);
                  // The template catalogue is per-account; a template picked
                  // for the old one may not exist on the new.
                  setSelectedTemplateId(null);
                  setIncludeOtherAccounts(false);
                }}
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              >
                {/* FAN-OUT, on the account-scoped channels only.
                    A Messenger PSID belongs to one Page and an Instagram IGSID to
                    one account, so no single account can reach everyone — but ONE
                    campaign can, by routing each recipient through the account
                    that issued their id. That is what this option means, and it
                    is why it cannot be offered on WhatsApp: there a phone number
                    is global, so which number sends is a real choice rather than
                    a forced one, and fanning it out would silently change who the
                    customer sees the message from. */}
                {isAccountScopedIdentity(selectedChannel) && (
                  <option value="">All accounts — reach everyone</option>
                )}
                {channelAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {a.providerName && a.providerName !== a.name
                      ? ` — ${a.providerName}`
                      : ""}
                  </option>
                ))}
              </select>
              {accountId === null && isAccountScopedIdentity(selectedChannel) && (
                <span className="text-2xs text-muted-foreground/70">
                  Each person is messaged from the account they originally wrote
                  to — Meta gives no way to reach them from any other.
                </span>
              )}
            </label>
          )}

          {/* Offered ONLY where reaching another account's contacts is possible.
              Meta scopes an Instagram id to "the person and the Instagram account
              they are interacting with", and a Messenger PSID the same way — so
              there the checkbox would promise an audience the send can never
              reach. A phone number is global, which is why WhatsApp keeps it. */}
          {channelAccounts.length > 1 && !isAccountScopedIdentity(selectedChannel) && (
            <label className="flex items-start gap-2 rounded-md border border-border bg-muted/20 px-3 py-2">
              <input
                type="checkbox"
                checked={includeOtherAccounts}
                onChange={(e) => setIncludeOtherAccounts(e.target.checked)}
                className="mt-0.5"
              />
              <span className="text-2xs leading-relaxed text-muted-foreground">
                Also include contacts from your other{" "}
                {CHANNEL_LABEL[selectedChannel]} accounts.
                <br />
                They haven&apos;t messaged this{" "}
                {selectedChannel === "whatsapp" ? "number" : "account"} before,
                so they&apos;ll see an unfamiliar sender and their reply opens
                a new conversation here.
              </span>
            </label>
          )}

          {selectedChannel === "whatsapp" ? (
            <p className="text-2xs leading-relaxed text-muted-foreground">
              Only a pre-approved <strong>template</strong> reaches someone
              outside the 24-hour customer service window. Templates belong to
              this account&apos;s WhatsApp Business Account, so the list below
              is scoped to it.
            </p>
          ) : (
            <p className="text-2xs leading-relaxed text-muted-foreground">
              {CHANNEL_LABEL[selectedChannel]} has no templates — free-form
              messages reach only contacts whose messaging window is still
              open. Everyone else is skipped.
            </p>
          )}
        </div>
      </StepCard>

      <StepCard
        index={2}
        title="Audience"
        summary={
          audienceDone
            ? audience.mode === "all"
              ? `All ${audienceCount} contact${audienceCount === 1 ? "" : "s"}`
              : audience.mode === "group"
                ? `${scopedGroup?.name ?? "group"} · ${audienceCount} member${audienceCount === 1 ? "" : "s"}`
                : `${audienceCount} recipient${audienceCount === 1 ? "" : "s"}`
            : undefined
        }
        done={audienceDone}
      >
        <AudiencePicker
          tags={tags}
          fieldDefinitions={fieldDefinitions}
          stages={stages}
          groups={groups}
          totalContactCount={totalContactCount}
          // Channel-scoped "all" count so the AllContactsCard's number matches
          // its channel-scoped copy (and the send footer). Falls back to the
          // unscoped total until the server count resolves.
          allContactsCount={allCount.resolved ? allCount.count : totalContactCount}
          initialContactLabels={initialContactLabels}
          value={audience}
          onChange={setAudience}
          onCustomCountChange={handleCustomCount}
          onGroupSaved={handleGroupSaved}
          // Scope the custom-audience recipient count to the channel AND the
          // "Send from" account the broadcast will actually use.
          channel={countChannel}
          accountId={accountId}
          includeOtherAccounts={includeOtherAccounts}
        />
      </StepCard>

      {messageKind !== "template" ? (
        <StepCard
          index={3}
          title="Message"
          summary={
            freeformDone
              ? `${CHANNEL_LABEL[freeformChannel]} · ${freeformBody.slice(0, 40)}`
              : undefined
          }
          done={freeformDone}
        >
          <div className="flex flex-col gap-3">
            {/* No channel toggle here: step 1 OWNS the channel. A second
                picker in this step used to bypass setSelectedChannel — flipping
                it silently rewrote step 1's summary while skipping the
                account/template resets. */}
            <Textarea
              value={freeformBody}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setFreeformBody(e.target.value)}
              placeholder="Type your message… (sent only to contacts inside their window)"
              rows={4}
              // A char maxLength can't express Instagram's byte cap, so in byte
              // mode we drop the hard limit and let the byte counter + the
              // freeformDone gate govern (mirrors the reply-box composer).
              maxLength={freeformByteMode ? undefined : freeformMaxChars}
            />
            <p className="text-2xs text-muted-foreground">
              Free-form messages reach only contacts within their messaging
              window; others are skipped.{" "}
              <span className={cn(freeformOverCap && "text-destructive")}>
                {freeformTextSize}/{freeformMaxChars}
                {freeformByteMode ? " bytes" : ""}
              </span>
            </p>
          </div>
        </StepCard>
      ) : (
        <StepCard
          index={3}
          title="Template"
          summary={
            selectedTemplate
              ? `${selectedTemplate.name} · ${selectedTemplate.language}`
              : undefined
          }
          done={templateDone}
        >
          <TemplatePickerInline
            templates={filteredTemplates}
            allTemplates={templates}
            query={templateQuery}
            onQueryChange={setTemplateQuery}
            loading={templatesLoading}
            syncing={templatesSyncing}
            error={templatesError}
            hasWabaId={hasWabaId}
            selectedId={selectedTemplateId}
            onSelect={setSelectedTemplateId}
            onRefresh={syncTemplates}
          />
        </StepCard>
      )}

      {/* Template-only. Without the messageKind gate, picking a template and then
          switching to Free-form left this step (and the warning below) on
          screen beside the free-form composer — two contradictory ways to
          compose one message. */}
      {messageKind === "template" && selectedTemplate && (
        <StepCard
          index={4}
          title="Variables"
          summary={
            variablesDone
              ? bodyVarCount + headerVarCount === 0
                ? "No variables"
                : `${bodyVarCount + headerVarCount} value${bodyVarCount + headerVarCount === 1 ? "" : "s"} filled`
              : undefined
          }
          done={variablesDone}
        >
          {bodyVarCount + headerVarCount === 0 &&
          !headerMediaKind &&
          !needsLocation &&
          cardRequirements.length === 0 &&
          !needsOfferExpiry ? (
            <div className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              This template has no variables — it&apos;ll send as-is to every
              recipient.
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {headerMediaKind && (
                <div>
                  <div className="mb-1.5 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                    {headerMediaKind} header — sent to every recipient
                  </div>
                  <HeaderMediaField
                    kind={headerMediaKind}
                    media={headerMedia}
                    uploading={headerMediaUploading}
                    error={headerMediaError}
                    onPick={uploadHeaderMedia}
                    onClear={() => {
                      setHeaderMedia(null);
                      setHeaderMediaError(null);
                    }}
                  />
                </div>
              )}
              {cardRequirements.length > 0 && (
                <CarouselCardsField
                  requirements={cardRequirements}
                  values={cards}
                  onChange={setCards}
                />
              )}
              {needsLocation && (
                <div className="flex flex-col gap-2">
                  <div className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                    Map header — the same pin for every recipient
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <PinField
                      label="Latitude"
                      placeholder="34.018818"
                      value={location.latitude}
                      onChange={(v) => setLocation((c) => ({ ...c, latitude: v }))}
                    />
                    <PinField
                      label="Longitude"
                      placeholder="-118.467087"
                      value={location.longitude}
                      onChange={(v) => setLocation((c) => ({ ...c, longitude: v }))}
                    />
                  </div>
                  <PinField
                    label="Place name (optional)"
                    placeholder="Lucky Shrub - Santa Monica"
                    value={location.name}
                    onChange={(v) => setLocation((c) => ({ ...c, name: v }))}
                  />
                  <PinField
                    label="Address (optional)"
                    placeholder="3250 Ocean Park Blvd, Santa Monica, CA 90405"
                    value={location.address}
                    onChange={(v) => setLocation((c) => ({ ...c, address: v }))}
                  />
                </div>
              )}
              {needsOfferExpiry && (
                <div>
                  <label
                    htmlFor="broadcast-lto-expiry"
                    className="mb-1.5 block text-2xs font-medium uppercase tracking-wide text-muted-foreground"
                  >
                    Offer expires — the countdown every recipient sees
                  </label>
                  <input
                    id="broadcast-lto-expiry"
                    type="datetime-local"
                    value={offerExpiresAt}
                    onChange={(e) => setOfferExpiresAt(e.target.value)}
                    className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/25"
                  />
                  {offerExpiresAt && offerExpiryMs === null && (
                    <p className="mt-1 text-2xs text-destructive">
                      Pick a time in the future — the countdown would already be over.
                    </p>
                  )}
                </div>
              )}
              {/* Campaign-level button values — one coupon code / URL suffix
                  every recipient gets. An LTO's code caps at 15, a plain
                  coupon at 20 (mirrored server-side). */}
              {buttonRequirements.map((b) => {
                const key = `${b.index}:${b.subType}`;
                const isCode = b.subType === "copy_code";
                const codeMax = isCode ? (needsOfferExpiry ? 15 : 20) : undefined;
                return (
                  <div key={key}>
                    <label
                      htmlFor={`broadcast-btn-${key}`}
                      className="mb-1.5 block text-2xs font-medium uppercase tracking-wide text-muted-foreground"
                    >
                      {isCode
                        ? `Coupon code — button #${b.index + 1}, same for every recipient`
                        : `URL button #${b.index + 1} value — appended to the button's link`}
                    </label>
                    <input
                      id={`broadcast-btn-${key}`}
                      value={buttonVals[key] ?? ""}
                      maxLength={codeMax}
                      onChange={(e) =>
                        setButtonVals((cur) => ({ ...cur, [key]: e.target.value }))
                      }
                      placeholder={isCode ? "e.g. WINTER25" : "e.g. summer-sale"}
                      className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/25"
                    />
                  </div>
                );
              })}
              {bodyVarCount + headerVarCount > 0 && (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Type a value or insert a{" "}
                  <code className="rounded bg-muted px-1 text-2xs">$var.contact.field</code>{" "}
                  token to fill each variable per recipient.
                </p>
              )}
              {headerVarCount > 0 && (
                <VarField
                  label={namedHeaderVar ? `Header {{${namedHeaderVar}}}` : "Header {{1}}"}
                  value={headerVar}
                  onChange={setHeaderVar}
                  fieldDefinitions={fieldDefinitions}
                />
              )}
              {bodyVars.map((v, i) => (
                <VarField
                  key={i}
                  // Named templates show the real placeholder name, so an
                  // author fills "order_id" rather than counting braces.
                  label={
                    isNamedTemplate
                      ? `Body {{${namedBodyVars[i] ?? i + 1}}}`
                      : `Body {{${i + 1}}}`
                  }
                  value={v}
                  onChange={(next) => {
                    setBodyVars((cur) => {
                      const copy = cur.slice();
                      copy[i] = next;
                      return copy;
                    });
                  }}
                  fieldDefinitions={fieldDefinitions}
                />
              ))}
            </div>
          )}

          <div className="mt-5">
            <div className="mb-2 flex items-center gap-2 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
              <span>Preview</span>
              <span className="h-px flex-1 bg-border" />
            </div>
            <PreviewBubble
              headerComp={headerComp}
              headerValue={resolveFieldTokens(headerVar, SAMPLE_CONTACT)}
              bodyText={selectedTemplate.bodyText}
              bodyVars={bodyVars.map((v) => resolveFieldTokens(v, SAMPLE_CONTACT))}
              footerComp={footerComp}
              buttonsComp={buttonsComp}
            />
          </div>
        </StepCard>
      )}

      {/* Who owns the replies. Only offered when the team actually has members
          to route to — a one-person org has nothing to decide here. */}
      {teamMembers.length > 1 && (
        <div className="rounded-xl border border-border bg-card p-4">
          <h2 className="text-sm font-semibold">Assignment</h2>
          <p className="mt-1 text-2xs text-muted-foreground">
            Decide up front who handles the replies, so they don&apos;t all land in
            one shared queue.
          </p>
          <div className="mt-3">
            <CampaignAssignment
              value={assignment}
              onChange={setAssignment}
              members={teamMembers}
              policies={assignmentPolicies}
              audienceSize={audienceCount}
            />
          </div>
        </div>
      )}

      {/* Details & schedule — optional name + send-now / schedule-later. */}
      <div className="rounded-xl border border-border bg-card p-4">
        <h2 className="text-sm font-semibold">Details &amp; schedule</h2>
        <div className="mt-3 flex flex-col gap-4">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              Broadcast name <span className="font-normal">(optional)</span>
            </span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value.slice(0, 120))}
              placeholder={selectedTemplate?.name ?? "e.g. Ramadan promo"}
              className="rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none focus:border-primary"
            />
            <span className="text-2xs text-muted-foreground/70">
              Shown in the broadcasts list. Falls back to the template name if blank.
            </span>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              Campaign <span className="font-normal">(optional)</span>
            </span>
            <input
              type="text"
              value={campaignName}
              onChange={(e) => setCampaignName(e.target.value.slice(0, 120))}
              list="known-campaigns"
              placeholder="e.g. Spring Sale"
              className="rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none focus:border-primary"
            />
            {/* Existing names, so an operator picks rather than retypes. The
                rollup groups on this string exactly — "Spring Sale " with a
                trailing space is a different campaign, and the only way to make
                that mistake is to type it again from memory. */}
            <datalist id="known-campaigns">
              {knownCampaigns.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
            <span className="text-2xs text-muted-foreground/70">
              Groups several broadcasts into one set of numbers — one per channel,
              a re-send to non-openers, a follow-up next week.
            </span>
          </label>

          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-muted-foreground">When to send</span>
            {/* Segmented Send now / Schedule toggle. */}
            <div className="inline-flex w-fit rounded-lg border border-border bg-muted/40 p-0.5 text-sm">
              <button
                type="button"
                onClick={() => setScheduleMode("now")}
                className={cn(
                  "rounded-md px-3 py-1 font-medium transition-colors",
                  scheduleMode === "now"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                Send now
              </button>
              <button
                type="button"
                onClick={() => setScheduleMode("later")}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md px-3 py-1 font-medium transition-colors",
                  scheduleMode === "later"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <CalendarClock className="size-3.5" />
                Schedule
              </button>
            </div>
            {scheduleMode === "later" && (
              <input
                type="datetime-local"
                value={scheduledLocal}
                onChange={(e) => setScheduledLocal(e.target.value)}
                // Block past times in the native picker; the submit-time guard
                // (when <= Date.now()) stays as the authoritative check.
                min={localDatetimeNow()}
                className="w-fit rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none focus:border-primary"
              />
            )}
          </div>
        </div>
      </div>

      <div className="sticky bottom-0 -mx-6 mt-2 border-t border-border bg-background/95 px-6 py-3 backdrop-blur">
        {sendError && (
          <div
            role="alert"
            className="mb-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span className="wrap-break-word">{sendError}</span>
          </div>
        )}
        {/* Pre-send eligibility: audience vs the number's WhatsApp messaging-limit
            tier. An over-cap audience is a hard error (create() rejects it too);
            a RED quality band is advisory. Only shown when we have a tier snapshot. */}
        {eligibilityWarning && (
          <div
            className={cn(
              "mb-3 rounded-md border px-3 py-2 text-xs",
              eligibilityWarning.level === "error"
                ? "border-destructive/30 bg-destructive/10 text-destructive"
                : "border-warning-border bg-warning-bg text-warning-fg",
            )}
          >
            <div className="flex items-start gap-1.5">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span className="wrap-break-word">{eligibilityWarning.text}</span>
            </div>
          </div>
        )}
        {/* Pre-send warning: recipients missing a mapped template field. Advisory
            only (Send stays enabled) — the agent can set a default, exclude them,
            or knowingly proceed (those recipients will fail with a clear reason). */}
        {messageKind === "template" && missingPreview && missingPreview.affectedCount > 0 && (
          <div className="rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-xs text-warning-fg">
            <div className="flex items-center gap-1.5 font-medium">
              <AlertTriangle className="size-3.5 shrink-0" />
              {missingPreview.sampled ? "At least " : ""}
              {missingPreview.affectedCount} recipient
              {missingPreview.affectedCount === 1 ? "" : "s"} will fail
            </div>
            <p className="mt-1 text-warning-fg/80">
              A template variable resolves to empty for{" "}
              {missingPreview.affectedCount === 1 ? "this contact" : "them"} —
              WhatsApp rejects templates with a blank variable. Set a default
              value on the variable (in the template&apos;s variable settings),
              or remove these contacts from the audience.
            </p>
            <ul className="mt-1 space-y-0.5 text-warning-fg/80">
              {missingPreview.missing.map((m, i) => (
                <li key={`${m.location}-${m.position}-${i}`}>
                  •{" "}
                  {m.location === "header"
                    ? "Header variable"
                    : `Variable {{${m.position}}}`}
                  {m.fieldLabel ? ` (${m.fieldLabel})` : ""}: {m.missingCount}{" "}
                  missing
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            {readyToSend ? (
              <span className="inline-flex items-center gap-1.5">
                <Send className="size-3.5" />
                Ready to send to{" "}
                <span className="font-medium text-foreground tabular-nums">
                  {audienceCount}
                </span>{" "}
                recipient{audienceCount === 1 ? "" : "s"}.
              </span>
            ) : (
              <span>{nextGateHint}</span>
            )}
            {previewPayload && audienceCount > 0 && (
              <button
                type="button"
                onClick={() => setPreviewOpen(true)}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-2xs font-medium text-foreground hover:bg-accent"
              >
                <Users className="size-3.5" />
                Preview recipients
              </button>
            )}
          </div>
          <Button
            type="button"
            onClick={submit}
            disabled={!readyToSend || sending}
            className="gap-1.5"
          >
            {sending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : scheduleMode === "later" ? (
              <CalendarClock className="size-4" />
            ) : (
              <Send className="size-4" />
            )}
            {sending
              ? scheduleMode === "later"
                ? "Scheduling…"
                : "Sending…"
              : scheduleMode === "later"
                ? "Schedule broadcast"
                : "Send broadcast"}
          </Button>
        </div>
      </div>

      <RecipientsPreviewDialog
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        payload={previewPayload}
        title="Broadcast recipients"
        subtitle={previewSubtitle}
      />
      {confirmDialog}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step card — a numbered section with collapse-to-summary behavior.
// ---------------------------------------------------------------------------

function StepCard({
  index,
  title,
  summary,
  done,
  children,
}: {
  index: number;
  title: string;
  summary?: string;
  done?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <header className="flex items-center gap-3 border-b border-border bg-muted/30 px-4 py-3">
        <div
          className={cn(
            "inline-flex size-7 items-center justify-center rounded-full text-xs font-semibold",
            done
              ? "bg-success-bg text-success-fg"
              : "bg-primary/10 text-primary",
          )}
        >
          {done ? <Check className="size-3.5" /> : index}
        </div>
        <div className="flex-1">
          <div className="text-sm font-semibold">{title}</div>
          {summary && (
            <div className="text-2xs text-muted-foreground">{summary}</div>
          )}
        </div>
      </header>
      <div className="px-4 py-4">{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Inline template list — same data shape as the inbox picker but rendered
// flat (no popover) because this whole page is the picker.
// ---------------------------------------------------------------------------

function TemplatePickerInline({
  templates,
  allTemplates,
  query,
  onQueryChange,
  loading,
  syncing,
  error,
  hasWabaId,
  selectedId,
  onSelect,
  onRefresh,
}: {
  templates: TemplateDto[];
  /** The UNFILTERED catalog — label vocabulary + the "Recently used" row are
   *  derived from it so they stay stable while the operator types. */
  allTemplates: TemplateDto[];
  query: string;
  onQueryChange: (q: string) => void;
  loading: boolean;
  syncing: boolean;
  error: string | null;
  hasWabaId: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRefresh: () => void;
}) {
  // Organizational-label filter chip — local to the picker, like the search box.
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  const labelOptions = useMemo(
    () => templateLabelVocabulary(allTemplates),
    [allTemplates],
  );
  const shown = useMemo(
    () =>
      labelFilter
        ? templates.filter((t) => templateHasLabel(t, labelFilter))
        : templates,
    [templates, labelFilter],
  );
  // Quick row: only when nothing narrows the list — a search or an active
  // chip already says what the operator wants.
  const recent = useMemo(
    () =>
      query.trim() || labelFilter ? [] : recentlyUsedTemplates(allTemplates),
    [allTemplates, query, labelFilter],
  );

  if (!hasWabaId) {
    return (
      <div className="rounded-md border border-warning-border bg-warning-bg p-4 text-xs">
        <div className="font-medium text-warning-fg">
          WhatsApp Business Account ID needed
        </div>
        <p className="mt-1 leading-relaxed text-muted-foreground">
          Templates live on your WABA. Add your ID in{" "}
          <Link href="/settings/whatsapp" className="text-primary hover:underline">
            Settings → WhatsApp
          </Link>{" "}
          to load and broadcast templates.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search templates…"
            aria-label="Search templates"
            className="h-9 pl-8"
          />
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onRefresh}
          disabled={syncing}
          className="h-9 gap-1.5 text-xs"
        >
          {syncing ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          Refresh
        </Button>
      </div>

      {/* Label filter chips — hidden until the workspace has labeled anything. */}
      {labelOptions.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {labelOptions.map((label) => {
            const active = labelFilter?.toLowerCase() === label.toLowerCase();
            return (
              <button
                key={label.toLowerCase()}
                type="button"
                onClick={() => setLabelFilter(active ? null : label)}
                aria-pressed={active}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-medium transition-colors",
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-muted/40 text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                <TagIcon className="size-2.5" aria-hidden="true" />
                {label}
              </button>
            );
          })}
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          <span>Loading templates…</span>
        </div>
      ) : shown.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-muted/20 px-3 py-6 text-center text-xs text-muted-foreground">
          {query.length > 0
            ? `No templates match "${query}".`
            : labelFilter
              ? "No templates carry this label."
              : "No templates yet. Approve some in WhatsApp Manager and click Refresh."}
        </div>
      ) : (
        <>
          {recent.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-1.5 text-3xs font-semibold uppercase tracking-wide text-muted-foreground">
                <Clock className="size-3" aria-hidden="true" />
                <span>Recently used</span>
              </div>
              <ul className="divide-y divide-border rounded-md border border-border bg-background">
                {recent.map((t) => (
                  <InlineTemplateRow
                    key={`recent-${t.id}`}
                    template={t}
                    selectedId={selectedId}
                    onSelect={onSelect}
                  />
                ))}
              </ul>
              <div className="mt-1 text-3xs font-semibold uppercase tracking-wide text-muted-foreground">
                All templates
              </div>
            </div>
          )}
          <ul className="divide-y divide-border rounded-md border border-border bg-background">
            {shown.map((t) => (
              <InlineTemplateRow
                key={t.id}
                template={t}
                selectedId={selectedId}
                onSelect={onSelect}
              />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function InlineTemplateRow({
  template: t,
  selectedId,
  onSelect,
}: {
  template: TemplateDto;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  // Commerce templates (catalog/MPM/SPM/order-details) need product
  // parameters the platform can't supply — the server refuses them,
  // so offering one here would be a dead click.
  const unsupported = unsupportedTemplateFeature(t.components);
  const sendable = t.status === "approved" && !unsupported;
  const selected = t.id === selectedId;
  return (
    <li>
      <button
        type="button"
        disabled={!sendable}
        onClick={() => onSelect(t.id)}
        className={cn(
          "group flex w-full cursor-pointer items-start gap-3 px-3 py-2.5 text-left transition-colors",
          "hover:bg-accent/50 focus:bg-accent/50 focus:outline-hidden",
          selected && "bg-primary/5 hover:bg-primary/5",
          !sendable && "cursor-not-allowed opacity-60 hover:bg-transparent",
        )}
      >
        <div
          className={cn(
            "mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-md",
            selected ? "bg-primary text-primary-foreground" : "bg-primary/10 text-primary",
          )}
        >
          <FileText className="size-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 truncate text-sm font-medium">{t.name}</span>
            <CategoryPill category={t.category} />
            <span className="rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-3xs text-muted-foreground">
              {t.language}
            </span>
            {!sendable && (
              <span className="rounded-full border border-warning-border bg-warning-bg px-1.5 py-0.5 text-3xs uppercase text-warning-fg">
                {unsupported ? `Needs ${unsupported}` : t.status}
              </span>
            )}
            <TemplateQualityPill score={t.qualityScore} />
            {/* Organizational labels — quieter than the state pills, capped so
                a heavily-tagged template doesn't wrap the whole row. */}
            {t.labels.slice(0, 2).map((label) => (
              <span
                key={label.toLowerCase()}
                className="inline-flex max-w-24 items-center gap-1 rounded-full border border-border bg-muted/40 px-1.5 py-0.5 text-3xs font-medium text-muted-foreground"
              >
                <TagIcon className="size-2.5 shrink-0" aria-hidden="true" />
                <span className="truncate">{label}</span>
              </span>
            ))}
            {t.labels.length > 2 && (
              <span
                className="text-3xs text-muted-foreground"
                title={t.labels.slice(2).join(", ")}
              >
                +{t.labels.length - 2}
              </span>
            )}
          </div>
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
            {t.bodyText || "—"}
          </p>
        </div>
        {selected ? (
          <Check className="mt-2 size-4 shrink-0 text-primary" />
        ) : sendable ? (
          <ChevronRight className="mt-2 size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
        ) : null}
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Small inline helpers
// ---------------------------------------------------------------------------

/**
 * Meta's per-TEMPLATE quality band, shown only when it is a warning: RED/YELLOW
 * mean the template drew negative feedback or low read-rates and risks a pause
 * (which auto-halts a campaign mid-send). GREEN and UNKNOWN are the healthy
 * default and render nothing — a pill on every row would bury the signal.
 * Carried verbatim from Meta, so an unrecognized band also stays silent.
 */
function TemplateQualityPill({ score }: { score: string | null }) {
  const band = score?.toUpperCase();
  if (band !== "RED" && band !== "YELLOW") return null;
  return (
    <span
      className={cn(
        "rounded-full border px-1.5 py-0.5 text-3xs font-medium uppercase",
        band === "RED"
          ? "border-destructive/30 bg-destructive/10 text-destructive"
          : "border-warning-border bg-warning-bg text-warning-fg",
      )}
    >
      {band === "RED" ? "Low quality" : "Medium quality"}
    </span>
  );
}

/**
 * One plain field of a LOCATION header's pin. Deliberately NOT a `VarField`:
 * coordinates are campaign-level constants, so there is no per-recipient token
 * to insert and offering the picker would only mislead.
 */
function PinField({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-2xs text-muted-foreground">{label}</span>
      <input
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm outline-none transition placeholder:text-muted-foreground/60 focus:border-ring focus:ring-2 focus:ring-ring/25"
      />
    </label>
  );
}

function VarField({
  label,
  value,
  onChange,
  fieldDefinitions,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  fieldDefinitions: ContactFieldDefinition[];
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Splice the token at the current cursor position. Falls back to appending
  // when the input isn't focused — same pattern the body editor on the
  // create-template form uses.
  const insertToken = useCallback(
    (token: string) => {
      const el = inputRef.current;
      if (!el || el.selectionStart === null) {
        onChange(value + token);
        return;
      }
      const start = el.selectionStart;
      const end = el.selectionEnd ?? start;
      onChange(value.slice(0, start) + token + value.slice(end));
      requestAnimationFrame(() => {
        el.focus();
        const pos = start + token.length;
        el.setSelectionRange(pos, pos);
      });
    },
    [value, onChange],
  );

  const unknown = useMemo(
    () => findUnknownTokens(value, fieldDefinitions),
    [value, fieldDefinitions],
  );
  const preview = useMemo(
    () => resolveFieldTokens(value, SAMPLE_CONTACT),
    [value],
  );
  const hasToken = /\$var\.contact\./.test(value);

  return (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-2xs font-medium text-foreground">{label}</span>
      <div className="flex items-center gap-1.5">
        <TokenHighlightInput
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Type a value or insert $var.contact.name"
          fieldDefinitions={fieldDefinitions}
        />
        <FieldTokenPicker
          fieldDefinitions={fieldDefinitions}
          onInsert={insertToken}
          hint="Tokens are replaced with each recipient's contact data at send time."
        />
      </div>
      {hasToken && (
        <div className="mt-0.5 flex items-center gap-1.5 text-2xs text-muted-foreground">
          <span className="font-medium">Sample:</span>
          <span className="truncate font-mono text-foreground">
            {preview || <span className="text-muted-foreground italic">(empty)</span>}
          </span>
        </div>
      )}
      {unknown.length > 0 && (
        <div className="mt-0.5 text-2xs text-warning-fg">
          Unknown token{unknown.length === 1 ? "" : "s"}:{" "}
          {unknown.join(", ")} — these will resolve to empty for every recipient.
        </div>
      )}
    </label>
  );
}

/**
 * Pick the natural token for a template binding so a newly-selected template
 * with bindings shows a fully wired-up form on first paint.
 *
 *   binding.source = contact_field.name   → "$var.contact.name"
 *   binding.source = contact_field.phoneNumber → "$var.contact.phone"
 *   binding.source = contact_custom_field.X  → "$var.contact.X"
 *   binding.source = manual / no binding → ""
 *
 * The phone-number alias is the one quirk: our schema field is camelCase
 * `phoneNumber` but the token reads better as `$var.contact.phone`.
 */
function tokenForBinding(binding: VariableBinding | undefined): string {
  if (!binding) return "";
  if (binding.source.kind === "manual") {
    return binding.defaultValue ?? "";
  }
  if (binding.source.kind === "contact_field") {
    const f = binding.source.field;
    const token = f === "phoneNumber" ? "phone" : f;
    return `$var.contact.${token}`;
  }
  if (binding.source.kind === "contact_custom_field") {
    return `$var.contact.${binding.source.key}`;
  }
  return "";
}

function PreviewBubble({
  headerComp,
  headerValue,
  bodyText,
  bodyVars,
  footerComp,
  buttonsComp,
}: {
  headerComp: TemplateComponent | undefined;
  headerValue: string;
  bodyText: string;
  bodyVars: string[];
  footerComp: TemplateComponent | undefined;
  buttonsComp: TemplateComponent | undefined;
}) {
  const renderedBody = renderPlaceholders(bodyText, bodyVars);
  const renderedHeader =
    headerComp?.format === "TEXT" && headerComp.text
      ? renderPlaceholders(headerComp.text, [headerValue])
      : null;
  return (
    <div className="rounded-lg border border-border bg-card p-3 shadow-xs">
      <div className="rounded-md bg-success-bg p-3 ring-1 ring-emerald-500/10">
        {headerComp?.format === "TEXT" && renderedHeader && (
          <div className="mb-1 text-sm font-semibold text-foreground">{renderedHeader}</div>
        )}
        {headerComp && headerComp.format !== "TEXT" && (
          <div className="mb-2 flex h-20 items-center justify-center rounded-md border border-dashed border-success-border bg-success-bg text-2xs text-muted-foreground">
            {headerComp.format ?? "MEDIA"} header
          </div>
        )}
        <div className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
          {renderedBody || <span className="text-muted-foreground">No body</span>}
        </div>
        {footerComp?.text && (
          <div className="mt-2 text-2xs text-muted-foreground">{footerComp.text}</div>
        )}
      </div>
      {buttonsComp?.buttons && buttonsComp.buttons.length > 0 && (
        <div className="mt-2 flex flex-col gap-1">
          {buttonsComp.buttons.map((b, i) => (
            <div
              key={i}
              className="rounded-md border border-border bg-background px-2 py-1.5 text-center text-xs font-medium text-primary"
            >
              {b.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CategoryPill({ category }: { category: string }) {
  const tone =
    category === "marketing"
      ? "border-pink-500/30 bg-pink-500/10 text-pink-700 dark:text-pink-300"
      : category === "utility"
        ? "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300"
        : "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300";
  return (
    <span
      className={cn(
        "rounded-full border px-1.5 py-0.5 text-3xs font-medium uppercase tracking-wide",
        tone,
      )}
    >
      {category}
    </span>
  );
}

function countPlaceholders(text: string): number {
  let max = 0;
  const re = /\{\{(\d+)\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

/**
 * Local wall-clock "now" as a datetime-local value (YYYY-MM-DDTHH:mm). Used as
 * the `min` so the native picker rejects a past time. Built from local fields
 * (NOT toISOString, which is UTC) to match the timezone-naive input.
 */
function localDatetimeNow(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Single-line, ellipsized clip for the confirm-dialog body preview. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + "…";
}

function renderPlaceholders(text: string, vars: string[]): string {
  return text.replace(/\{\{(\d+)\}\}/g, (_match, idxStr) => {
    const idx = Number(idxStr) - 1;
    const v = vars[idx];
    return v && v.length > 0 ? v : `{{${idxStr}}}`;
  });
}

async function safeReadError(res: Response): Promise<string> {
  try {
    const json = (await res.json()) as { error?: string; detail?: string };
    if (json.detail) return `${json.error ?? "error"}: ${json.detail}`;
    return apiErrorMessageFrom(json, `HTTP ${res.status}`);
  } catch {
    return `HTTP ${res.status}`;
  }
}
