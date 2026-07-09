import "server-only";

import { cache } from "react";

import type { WorkflowTriggerEvent } from "@prisma/client";

import { api } from "../api-client";
import type {
  AudienceGroupDto,
  ListContactsOpts,
  PlatformAnalytics,
  SuperAdminTeamDetail,
  SuperAdminTeamRow,
  WhatsappConfigView,
} from "@ccp/shared/dtos";
import type {
  ChannelMessagesPage,
  ChannelPinDto,
  TeamChannelDto,
  TeamChannelListItemDto,
} from "@ccp/shared/team-chat/types";
import type {
  Contact,
  ContactFieldDefinition,
  ContactListItem,
  ContactPanelBuiltins,
  ContactStage,
  ConversationWithRefs,
  CursorPage,
  Role,
  Tag,
  TemplateDto,
  User,
} from "@ccp/shared/types";

/**
 * Inline DTOs that the API ships but apps/api defines locally in its
 * service files. Kept here (not in @ccp/shared) because the source-of-truth
 * lives next to the controller; this is just the consumer-side mirror so
 * web pages can name the response shape.
 */
export interface SnippetDto {
  id: string;
  name: string;
  label: string;
  body: string;
  createdById: string | null;
  createdByName: string;
  updatedAt: string;
}

/**
 * Server-side HTTP query layer used by RSC pages + server actions.
 *
 * Mirrors the function names that used to come out of `@/lib/queries`
 * (which itself shimmed apps/api/src/lib/queries/* across the package
 * boundary). Each function here is a thin api() wrapper — URL contracts
 * live here so pages don't repeat them.
 *
 * NOT for client components: api-client.ts depends on cookies()/headers()
 * from next/headers, which only run in RSC + server actions. The browser
 * talks to NestJS directly via plain fetch.
 */

// ---------------------------------------------------------------------------
// Team root + members
// ---------------------------------------------------------------------------

// Catalog fetches deliberately do NOT use Next.js' fetch cache as of
// 2026-05-19. `revalidateTag` from the /api/internal/revalidate bridge
// was leaving entries stale in practice on Next 16 — operators saw old
// snippet / tag / field lists for the full revalidate window even after
// their own edits. Trading the cache win for guaranteed freshness; the
// per-call docker-network round trip is single-digit ms.

/**
 * Wrapped in `React.cache` so the (app) route-group layout and each
 * section's SectionShell share one HTTP round-trip per render. Without
 * this, every authenticated page paid 2x the /api/team latency on every
 * nav (parent layout + SectionShell each calling independently).
 */
export interface CurrentTeam {
  id: string;
  name: string;
  aiAutopilotEnabled: boolean;
  aiHandoffAction: "none" | "unassign" | "assign_fixed" | "round_robin";
  aiHandoffAssigneeId: string | null;
  firstTouchGreeter: "ai" | "workflow";
}

export const getCurrentTeam = cache(async (): Promise<CurrentTeam> => {
  const { team } = await api<{ team: CurrentTeam }>("/api/team");
  return team;
});

// Wrapped in `React.cache` so a section's layout (e.g. the inbox sub-sidebar's
// teammate list) and its page (message attribution / @-picker) share one
// `/api/users` round-trip per render instead of fetching twice on every nav.
// Per-render dedupe only — a fresh navigation still re-fetches.
export const listTeamMembers = cache(async (): Promise<User[]> => {
  const { users } = await api<{ users: User[] }>("/api/users");
  return users;
});

/** Period window for the team-activity report. `all` = all-time. */
export type StatsPeriod = "day" | "week" | "month" | "year" | "all";

/** Per-member activity for the team-activity settings page (admin-only). */
export interface MemberStat {
  userId: string;
  name: string;
  email: string;
  role: Role;
  deactivated: boolean;
  /** Chats currently assigned (point-in-time, ignores the period). */
  activeAssigned: number;
  /** Assignment actions to them within the period. */
  assigned: number;
  /** Outbound messages they sent within the period. */
  messagesSent: number;
  /** Conversations they closed within the period. */
  closed: number;
}

export const getMemberStats = cache(
  async (period: StatsPeriod = "all"): Promise<MemberStat[]> => {
    const { stats } = await api<{ stats: MemberStat[] }>(
      `/api/users/stats?period=${period}`,
    );
    return stats;
  },
);

// ---------------------------------------------------------------------------
// Super-admin (cross-team)
// ---------------------------------------------------------------------------

export async function listAllTeamsForSuperAdmin(): Promise<SuperAdminTeamRow[]> {
  const { teams } = await api<{ teams: SuperAdminTeamRow[] }>("/api/admin/teams");
  return teams;
}

export async function getTeamDetailForSuperAdmin(
  teamId: string,
): Promise<SuperAdminTeamDetail | null> {
  try {
    return await api<SuperAdminTeamDetail>(`/api/admin/teams/${teamId}`);
  } catch (err) {
    if (isApiNotFound(err)) return null;
    throw err;
  }
}

export async function getPlatformAnalytics(): Promise<PlatformAnalytics> {
  return api<PlatformAnalytics>("/api/admin/analytics");
}

// ---------------------------------------------------------------------------
// Catalogs (tags / snippets / stages / contact fields / audience groups)
// ---------------------------------------------------------------------------

// NOTE: cache tags removed 2026-05-19. Next 16's `revalidateTag` from the
// `/api/internal/revalidate` bridge wasn't reliably busting these fetch-cache
// entries — operators saw stale snippet / tag / stage / field lists for the
// full 60s window even after their own edits. Strip the cache so every RSC
// render hits NestJS fresh. Cost: ~5-15ms per call docker-network. Acceptable
// at pilot scale. Re-introduce a working cache layer once we trust the bust.
export async function listTags(): Promise<Tag[]> {
  const { tags } = await api<{ tags: Tag[] }>("/api/team/tags");
  return tags;
}

export async function getTagUsage(): Promise<Record<string, number>> {
  const { usage } = await api<{ usage: Record<string, number> }>("/api/team/tags/usage");
  return usage;
}

export async function listSnippets(): Promise<SnippetDto[]> {
  const { snippets } = await api<{ snippets: SnippetDto[] }>("/api/team/snippets");
  return snippets;
}

// Wrapped in `React.cache` so the contacts layout (for the sub-sidebar's
// stage chips) and the contacts page (for the table's stage column) share
// one fetch per render — without this, navigating into /contacts paid 2x
// the `/api/team/stages` RTT every click. Per-render dedupe only; fresh
// fetch on each new navigation, which preserves the "always-fresh catalog"
// behaviour the rest of this file aims for.
export const listContactStages = cache(async (): Promise<ContactStage[]> => {
  const { stages } = await api<{ stages: ContactStage[] }>("/api/team/stages");
  return stages;
});

export async function getStageContactCounts(): Promise<{
  countsByStageId: Record<string, number>;
  unassignedCount: number;
}> {
  return api<{
    countsByStageId: Record<string, number>;
    unassignedCount: number;
  }>("/api/team/stages/counts");
}

export async function listContactFieldDefinitions(): Promise<ContactFieldDefinition[]> {
  const { definitions } = await api<{ definitions: ContactFieldDefinition[] }>(
    "/api/team/contact-fields",
  );
  return definitions;
}

export async function listContactFieldsWithBuiltins(): Promise<{
  definitions: ContactFieldDefinition[];
  builtins: ContactPanelBuiltins;
}> {
  return api<{ definitions: ContactFieldDefinition[]; builtins: ContactPanelBuiltins }>(
    "/api/team/contact-fields",
  );
}

export async function listAudienceGroups(): Promise<AudienceGroupDto[]> {
  const { groups } = await api<{ groups: AudienceGroupDto[] }>("/api/team/audience-groups");
  return groups;
}

export async function getAudienceGroup(id: string): Promise<AudienceGroupDto | null> {
  try {
    const { group } = await api<{ group: AudienceGroupDto }>(`/api/team/audience-groups/${id}`);
    return group;
  } catch (err) {
    if (isApiNotFound(err)) return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Conversations + messages
// ---------------------------------------------------------------------------

export interface ListConversationsOpts {
  take?: number;
  cursor?: string | null;
  search?: string;
}

// Wrapped in `React.cache` so the inbox layout (sub-sidebar count fallback)
// and the inbox page (conversation list seed) share one `/api/conversations`
// round-trip per render. React.cache keys on the arguments, so the no-arg
// calls both sides make dedupe to a single fetch; callers passing distinct
// `opts` objects are unaffected (fresh fetch, as before).
//
// Deliberately UNFILTERED: the sub-sidebar's first-paint fallback derives the
// `closed` preset count from this seed (presetCounts in inbox-sub-sidebar),
// so the SSR slice has to include closed rows for the count to be right
// before `useConversationCounts` lands. The conversation LIST consumer
// (`useTeamEvents`) prunes the seed against the active client-side filter on
// mount so closed rows don't leak into "All open".
export const listConversations = cache(async (
  opts: ListConversationsOpts = {},
): Promise<CursorPage<ConversationWithRefs>> => {
  return api<CursorPage<ConversationWithRefs>>("/api/conversations", {
    query: {
      take: opts.take,
      cursor: opts.cursor ?? undefined,
      search: opts.search ?? undefined,
    },
  });
});

export async function getConversationWithRefs(
  conversationId: string,
): Promise<{ data: ConversationWithRefs; nextOlderCursor: string | null } | null> {
  try {
    return await api<{
      data: ConversationWithRefs;
      nextOlderCursor: string | null;
    }>(`/api/inbox/conversation/${conversationId}`);
  } catch (err) {
    if (isApiNotFound(err)) return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export async function listContacts(
  opts: ListContactsOpts = {},
): Promise<CursorPage<ContactListItem>> {
  return api<CursorPage<ContactListItem>>("/api/contacts", {
    query: {
      search: opts.search,
      cursor: opts.cursor ?? undefined,
      // Numbered (offset) pagination — the /contacts page seeds page 1 in this
      // mode so the SSR rows match the paginated client (see contacts/page.tsx).
      page: opts.page,
      take: opts.take,
      fieldKey: opts.fieldFilter?.key,
      fieldValue: opts.fieldFilter?.value,
      source: opts.source,
      tagIds: opts.tagIds && opts.tagIds.length > 0 ? opts.tagIds.join(",") : undefined,
      window: opts.window,
      stageId: opts.stageId,
    },
  });
}

export async function countContacts(audience: {
  tagIds?: string[];
  contactIds?: string[];
}): Promise<number> {
  const { count } = await api<{ count: number }>("/api/contacts/count", {
    method: "POST",
    body: {
      tagIds: audience.tagIds ?? [],
      contactIds: audience.contactIds ?? [],
    },
  });
  return count;
}

/**
 * Total contacts in the team — distinct from `countContacts` which resolves an
 * audience union (returns 0 for an empty filter, by design). Used by the
 * broadcast wizard's "All contacts" card so the recipient count reads the
 * real team size, not 0.
 */
export async function countAllContacts(): Promise<number> {
  const { count } = await api<{ count: number }>("/api/contacts/count-all", {
    method: "GET",
  });
  return count;
}

export async function lookupContacts(ids: string[]): Promise<Contact[]> {
  if (ids.length === 0) return [];
  const { contacts } = await api<{ contacts: Contact[] }>("/api/contacts/lookup", {
    query: { ids: ids.join(",") },
  });
  return contacts;
}

// ---------------------------------------------------------------------------
// Team chat channels
// ---------------------------------------------------------------------------

export async function listChannelsForUser(): Promise<TeamChannelListItemDto[]> {
  const { items } = await api<{ items: TeamChannelListItemDto[] }>("/api/team/channels");
  return items;
}

export async function getDefaultChannel(): Promise<TeamChannelDto | null> {
  const { channel } = await api<{ channel: TeamChannelDto | null }>(
    "/api/team/channels/default",
  );
  return channel;
}

export async function getChannelById(channelId: string): Promise<TeamChannelDto | null> {
  const { channel } = await api<{ channel: TeamChannelDto | null }>(
    `/api/team/channels/${channelId}`,
  );
  return channel;
}

export async function listChannelMessages(
  channelId: string,
  opts: { take?: number; before?: string } = {},
): Promise<ChannelMessagesPage> {
  return api<ChannelMessagesPage>(`/api/team/channels/${channelId}/messages`, {
    query: { take: opts.take, before: opts.before },
  });
}

export async function listChannelPins(channelId: string): Promise<ChannelPinDto[]> {
  const { pins } = await api<{ pins: ChannelPinDto[] }>(
    `/api/team/channels/${channelId}/pins`,
  );
  return pins;
}

// ---------------------------------------------------------------------------
// WhatsApp settings + templates
// ---------------------------------------------------------------------------

export async function getTeamWhatsappConfig(): Promise<WhatsappConfigView> {
  const { config } = await api<{ config: WhatsappConfigView }>("/api/team/whatsapp");
  return config;
}

/** Server→browser view for the Messenger connect form (mirrors the API shape). */
export interface MessengerConfigView {
  pageId: string | null;
  pageName: string | null;
  appId: string | null;
  verifyToken: string | null;
  pageAccessToken: string | null;
  appSecret: string | null;
  credentialsUndecryptable: boolean;
}

export async function getTeamMessengerConfig(): Promise<MessengerConfigView> {
  const { config } = await api<{ config: MessengerConfigView }>("/api/team/messenger");
  return config;
}

/** Server→browser view for the Instagram connect form (mirrors the API shape). */
export interface InstagramConfigView {
  igId: string | null;
  igUsername: string | null;
  pageId: string | null;
  pageName: string | null;
  appId: string | null;
  verifyToken: string | null;
  igAccessToken: string | null;
  appSecret: string | null;
  credentialsUndecryptable: boolean;
}

export async function getTeamInstagramConfig(): Promise<InstagramConfigView> {
  const { config } = await api<{ config: InstagramConfigView }>("/api/team/instagram");
  return config;
}

/** Server→browser view for the shared Meta App connection form. */
export interface MetaConfigView {
  appId: string | null;
  verifyToken: string | null;
  appSecret: string | null;
  systemUserToken: string | null;
  credentialsUndecryptable: boolean;
}
export async function getTeamMetaConfig(): Promise<MetaConfigView> {
  const { config } = await api<{ config: MetaConfigView }>("/api/team/meta");
  return config;
}

export async function listWhatsappTemplates(): Promise<{
  templates: TemplateDto[];
  hasWabaId: boolean;
  hasAppId: boolean;
  connected: boolean;
}> {
  return api("/api/team/whatsapp/templates");
}

// ---------------------------------------------------------------------------
// Broadcasts
// ---------------------------------------------------------------------------

export interface BroadcastListItem {
  id: string;
  status: string;
  name: string | null;
  scheduledAt: string | null;
  templateName: string;
  templateLanguage: string;
  audienceMode: string;
  totalCount: number;
  sentCount: number;
  failedCount: number;
  createdById: string | null;
  createdByName: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface BroadcastDetail extends BroadcastListItem {
  templateId: string;
  audienceTagIds: string[];
  audienceGroupId: string | null;
  variables: unknown;
  lastError: string | null;
  recipients: Array<{
    id: string;
    contactId: string;
    contactName: string;
    contactPhone: string | null;
    conversationId: string | null;
    status: string;
    externalId: string | null;
    errorMessage: string | null;
    sentAt: string | null;
  }>;
}

export async function listBroadcasts(opts?: {
  status?: string;
  search?: string;
  /** Numbered (offset) pagination — when set, the API returns `totalCount`. */
  page?: number;
  take?: number;
}): Promise<{ broadcasts: BroadcastListItem[]; totalCount?: number }> {
  const params = new URLSearchParams();
  if (opts?.status && opts.status !== "all") params.set("status", opts.status);
  if (opts?.search) params.set("search", opts.search);
  if (opts?.page != null) params.set("page", String(opts.page));
  if (opts?.take != null) params.set("take", String(opts.take));
  const qs = params.toString();
  return api<{ broadcasts: BroadcastListItem[]; totalCount?: number }>(
    `/api/broadcasts${qs ? `?${qs}` : ""}`,
  );
}

export async function getBroadcast(id: string): Promise<BroadcastDetail | null> {
  try {
    const { broadcast } = await api<{ broadcast: BroadcastDetail }>(`/api/broadcasts/${id}`);
    return broadcast;
  } catch (err) {
    if (isApiNotFound(err)) return null;
    throw err;
  }
}

/**
 * All recipient contact ids for a broadcast — used by "Duplicate" to rebuild a
 * hand-picked (`selected`/`custom`) audience that only lives on recipient rows.
 * Returns [] on a missing/foreign id so a stale `?from=` degrades gracefully.
 */
export async function getBroadcastRecipientContactIds(id: string): Promise<string[]> {
  try {
    const { contactIds } = await api<{ contactIds: string[] }>(
      `/api/broadcasts/${id}/recipient-ids`,
    );
    return contactIds;
  } catch (err) {
    if (isApiNotFound(err)) return [];
    throw err;
  }
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

export interface ApiKeyListItem {
  id: string;
  name: string;
  tokenPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  scopes: string[];
}

export async function listApiKeys(): Promise<ApiKeyListItem[]> {
  const { keys } = await api<{ keys: ApiKeyListItem[] }>("/api/team/api-keys");
  return keys;
}

// ---------------------------------------------------------------------------
// Outbound webhooks
// ---------------------------------------------------------------------------

export interface OutboundWebhookListItem {
  id: string;
  name: string;
  url: string;
  eventTypes: string[];
  enabled: boolean;
  consecutiveFailures: number;
  createdAt: string;
  lastDeliveredAt: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
  /** Audit trail for auto-disabled subscriptions — null on manual disable. */
  disabledAt: string | null;
  disabledReason: string | null;
}

export async function listOutboundWebhooks(): Promise<OutboundWebhookListItem[]> {
  const { webhooks } = await api<{ webhooks: OutboundWebhookListItem[] }>(
    "/api/team/outbound-webhooks",
  );
  return webhooks;
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

export interface WorkflowListItem {
  id: string;
  name: string;
  published: boolean;
  trigger: string;
  stepCount: number;
  firstStepLabel: string;
  runCount: number;
  createdAt: string;
  updatedAt: string;
}

export async function listWorkflows(): Promise<WorkflowListItem[]> {
  const { workflows } = await api<{ workflows: WorkflowListItem[] }>("/api/team/workflows");
  return workflows;
}

/**
 * Composite reader used by the workflow builder pages — loads every catalog
 * the canvas needs to render its node palette in one fan-out call. Remaps
 * the wider API shapes down to the minimal `{id, name, …}` shapes the
 * builder consumes so the wire response stays general-purpose.
 */
export async function loadWorkflowCatalogs(): Promise<{
  users: Array<{ id: string; name: string; email: string }>;
  templates: Array<{
    id: string;
    name: string;
    bodyText: string;
    language: string;
    status: string;
  }>;
  tags: Array<{ id: string; name: string; color: string }>;
  stages: Array<{ id: string; name: string; position: number }>;
  fields: Array<{ key: string; label: string }>;
  workflows: Array<{ id: string; name: string; trigger: WorkflowTriggerEvent }>;
}> {
  const [users, templates, tags, stages, fields, workflows] = await Promise.all([
    listTeamMembers(),
    listWhatsappTemplates(),
    listTags(),
    listContactStages(),
    listContactFieldDefinitions(),
    listWorkflows(),
  ]);
  return {
    users: users
      .filter((u) => u.isActive)
      .map((u) => ({ id: u.id, name: u.name, email: u.email })),
    templates: templates.templates.map((t) => ({
      id: t.id,
      name: t.name,
      bodyText: t.bodyText,
      language: t.language,
      status: t.status,
    })),
    tags: tags.map((t) => ({ id: t.id, name: t.name, color: t.color })),
    stages: stages.map((s) => ({ id: s.id, name: s.name, position: s.position })),
    fields: fields.map((f) => ({ key: f.key, label: f.label })),
    workflows: workflows
      .filter((w) => w.trigger === "manual_trigger")
      .map((w) => ({
        id: w.id,
        name: w.name,
        trigger: w.trigger as WorkflowTriggerEvent,
      })),
  };
}

export async function getWorkflow(id: string): Promise<Record<string, unknown> | null> {
  try {
    return await api<Record<string, unknown>>(`/api/team/workflows/${id}`);
  } catch (err) {
    if (isApiNotFound(err)) return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

export interface InviteListDto {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
  createdAt: string;
  createdByName: string;
}

export async function listInvites(): Promise<InviteListDto[]> {
  const { invites } = await api<{ invites: InviteListDto[] }>("/api/invites");
  return invites;
}

export interface InviteLookupResult {
  status: "valid" | "invalid" | "used" | "expired";
  invite: { email: string; role: Role; teamName: string } | null;
}

export async function lookupInvite(token: string): Promise<InviteLookupResult> {
  // Public endpoint — but still routed through api() so the cookie
  // forward + x-forwarded-for stay consistent. 401 won't fire here.
  return api<InviteLookupResult>(`/api/invites/lookup/${encodeURIComponent(token)}`, {
    on401: "throw",
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isApiNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    (err as { status?: number }).status === 404
  );
}
