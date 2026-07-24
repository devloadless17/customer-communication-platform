import "server-only";

import { cache } from "react";

import type { WorkflowTriggerEvent } from "@prisma/client";
import type { InboxView } from "@ccp/shared/inbox-views/types";

import { api } from "../api-client";
import type {
  AudienceGroupDto,
  ListContactsOpts,
  PlatformAnalytics,
  SuperAdminTeamDetail,
  SuperAdminTeamRow,
  SuperAdminOrgRow,
  WhatsappConfigView,
} from "@ccp/shared/dtos";
import type {
  ChannelMessagesPage,
  ChannelPinDto,
  TeamChannelBrowseItemDto,
  TeamChannelDto,
  TeamChannelListItemDto,
  TeamDmListItemDto,
} from "@ccp/shared/team-chat/types";
import type {
  Channel,
  Contact,
  ContactFieldDefinition,
  ContactListItem,
  ContactPanelBuiltins,
  ContactStage,
  ConversationWithRefs,
  CursorPage,
  MessageFlagDefinition,
  Role,
  Tag,
  TemplateDto,
  User,
} from "@ccp/shared/types";
import type { MessageFlagDefinitionWithUsage } from "@ccp/shared/message-flags/types";
import type {
  Ticket as TicketView,
  TicketEvent as TicketEventView,
  TicketFieldDefinition,
  TicketSlaPolicy,
} from "@ccp/shared/tickets/types";

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
 * this, every authenticated page paid 2x the /api/workspace latency on every
 * nav (parent layout + SectionShell each calling independently).
 */
export interface CurrentTeam {
  id: string;
  name: string;
  aiAutopilotEnabled: boolean;
  aiHandoffAction: "none" | "unassign" | "assign_fixed" | "round_robin";
  aiHandoffAssigneeId: string | null;
  firstTouchGreeter: "ai" | "workflow";
  /** Org-wide agent read boundary — "team" (default) or "assigned". */
  agentConversationVisibility: "team" | "assigned";
}

export const getCurrentTeam = cache(async (): Promise<CurrentTeam> => {
  const { team } = await api<{ team: CurrentTeam }>("/api/workspace");
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

/**
 * The org's default working-hours schedule (null = none configured, which is
 * the default and keeps availability purely manual). Read on its own rather
 * than folded into `/api/workspace` because only the Team settings page needs the
 * JSON grid.
 */
export const getTeamWorkHours = cache(async (): Promise<unknown> => {
  const { workHours } = await api<{ workHours: unknown }>("/api/workspace/work-hours");
  return workHours ?? null;
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

/** Organisations with their workspaces nested — what the platform list shows. */
export async function listAllOrgsForSuperAdmin(): Promise<SuperAdminOrgRow[]> {
  const { orgs } = await api<{ orgs: SuperAdminOrgRow[] }>("/api/admin/teams");
  return orgs;
}

export async function getTeamDetailForSuperAdmin(
  workspaceId: string,
): Promise<SuperAdminTeamDetail | null> {
  try {
    return await api<SuperAdminTeamDetail>(`/api/admin/teams/${workspaceId}`);
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
/** Org, its workspaces (with counts) and its members — Organization settings. */
export async function getOrganizationOverview(): Promise<OrganizationOverview> {
  return api<OrganizationOverview>("/api/workspaces/organization");
}

export interface OrganizationOverview {
  id: string;
  name: string;
  plan: string;
  status: string;
  workspaces: Array<{
    id: string;
    name: string;
    memberCount: number;
    conversationCount: number;
    channelAccountCount: number;
    /** Whether the viewer can open this one. */
    joined: boolean;
    createdAt: string;
  }>;
  members: Array<{
    id: string;
    name: string;
    email: string;
    avatarUrl: string | null;
    orgRole: string;
    isActive: boolean;
    memberships: Array<{ workspaceId: string; role: string }>;
  }>;
  /** Mirrors the server's `orgRole` gate, so the UI never offers a refused button. */
  canManage: boolean;
}

/** One ticket plus its timeline. Throws (→ notFound) when it isn't ours. */
export async function getTicket(
  id: string,
): Promise<{ ticket: TicketView; events: TicketEventView[] }> {
  return api<{ ticket: TicketView; events: TicketEventView[] }>(`/api/tickets/${id}`);
}

/** Ticketing configuration for the settings page, in one round-trip. */
export async function getTicketSettings(): Promise<{
  settings: TicketSettingsView;
  policies: TicketSlaPolicy[];
  fields: TicketFieldDefinition[];
}> {
  const [settings, sla, fieldsRes] = await Promise.all([
    api<TicketSettingsView>("/api/workspace/tickets/settings"),
    api<{ policies: TicketSlaPolicy[] }>("/api/workspace/tickets/sla"),
    api<{ fields: TicketFieldDefinition[] }>("/api/workspace/tickets/fields"),
  ]);
  return { settings, policies: sla.policies, fields: fieldsRes.fields };
}

export interface TicketSettingsView {
  ticketAutoOpen: boolean;
  ticketReopenWindowHours: number;
  ticketCloseConversationOnLastSolved: boolean;
}

export async function listTags(): Promise<Tag[]> {
  const { tags } = await api<{ tags: Tag[] }>("/api/workspace/tags");
  return tags;
}

/** Assignment policies, id + name only. Session-gated (not admin-gated) so the
 *  workflow builder and the broadcast composer can offer a policy picker to any
 *  member who can edit them. */
export async function listAssignmentPolicies(): Promise<
  Array<{ id: string; name: string; isDefault: boolean }>
> {
  const { policies } = await api<{
    policies: Array<{ id: string; name: string; isDefault: boolean }>;
  }>("/api/workspace/assignment-policies");
  return policies;
}

/**
 * The team's message-flag catalog — LIVE definitions only (archived ones are
 * excluded server-side), for the inbox flag picker.
 */
export async function listMessageFlagDefinitions(): Promise<MessageFlagDefinition[]> {
  const { definitions } = await api<{ definitions: MessageFlagDefinition[] }>(
    "/api/workspace/message-flags",
  );
  return definitions;
}

/** Settings view of the same catalog — archived included, with usage counts. */
export async function listMessageFlagDefinitionsWithUsage(): Promise<
  MessageFlagDefinitionWithUsage[]
> {
  const { definitions } = await api<{ definitions: MessageFlagDefinitionWithUsage[] }>(
    "/api/workspace/message-flags/usage",
  );
  return definitions;
}

export async function getTagUsage(): Promise<Record<string, number>> {
  const { usage } = await api<{ usage: Record<string, number> }>("/api/workspace/tags/usage");
  return usage;
}

export async function listSnippets(): Promise<SnippetDto[]> {
  const { snippets } = await api<{ snippets: SnippetDto[] }>("/api/workspace/snippets");
  return snippets;
}

// Wrapped in `React.cache` so the contacts layout (for the sub-sidebar's
// stage chips) and the contacts page (for the table's stage column) share
// one fetch per render — without this, navigating into /contacts paid 2x
// the `/api/workspace/stages` RTT every click. Per-render dedupe only; fresh
// fetch on each new navigation, which preserves the "always-fresh catalog"
// behaviour the rest of this file aims for.
export const listContactStages = cache(async (): Promise<ContactStage[]> => {
  const { stages } = await api<{ stages: ContactStage[] }>("/api/workspace/stages");
  return stages;
});

/**
 * Saved inbox views visible to the signed-in agent (shared + their own).
 *
 * `cache`d for the same reason as the stage catalog: the inbox LAYOUT renders
 * the views rail while the PAGE seeds the list's view lookup, and both would
 * otherwise pay the round-trip on every navigation.
 */
export const listInboxViews = cache(async (): Promise<InboxView[]> => {
  const { views } = await api<{ views: InboxView[] }>("/api/inbox-views");
  return views;
});

export async function getStageContactCounts(): Promise<{
  countsByStageId: Record<string, number>;
  unassignedCount: number;
}> {
  return api<{
    countsByStageId: Record<string, number>;
    unassignedCount: number;
  }>("/api/workspace/stages/counts");
}

export async function listContactFieldDefinitions(): Promise<ContactFieldDefinition[]> {
  const { definitions } = await api<{ definitions: ContactFieldDefinition[] }>(
    "/api/workspace/contact-fields",
  );
  return definitions;
}

export async function listContactFieldsWithBuiltins(): Promise<{
  definitions: ContactFieldDefinition[];
  builtins: ContactPanelBuiltins;
}> {
  return api<{ definitions: ContactFieldDefinition[]; builtins: ContactPanelBuiltins }>(
    "/api/workspace/contact-fields",
  );
}

export async function listAudienceGroups(): Promise<AudienceGroupDto[]> {
  const { groups } = await api<{ groups: AudienceGroupDto[] }>("/api/workspace/audience-groups");
  return groups;
}

export async function getAudienceGroup(id: string): Promise<AudienceGroupDto | null> {
  try {
    const { group } = await api<{ group: AudienceGroupDto }>(`/api/workspace/audience-groups/${id}`);
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
  const { items } = await api<{ items: TeamChannelListItemDto[] }>("/api/team-chat/channels");
  return items;
}

/** The viewer's 1:1 DMs, most-recently-active first. */
export async function listDirectMessagesForUser(): Promise<TeamDmListItemDto[]> {
  const { items } = await api<{ items: TeamDmListItemDto[] }>("/api/team-chat/channels/dms");
  return items;
}

/**
 * Metadata for a public channel the viewer hasn't joined. Backs the
 * "join to see this channel" card, so a null result (private / DM / missing)
 * is the signal to 404.
 */
export async function getPublicChannelPreview(
  channelId: string,
): Promise<TeamChannelBrowseItemDto | null> {
  const { channel } = await api<{ channel: TeamChannelBrowseItemDto | null }>(
    `/api/team-chat/channels/${channelId}/preview`,
  );
  return channel;
}

export async function getDefaultChannel(): Promise<TeamChannelDto | null> {
  const { channel } = await api<{ channel: TeamChannelDto | null }>(
    "/api/team-chat/channels/default",
  );
  return channel;
}

export async function getChannelById(channelId: string): Promise<TeamChannelDto | null> {
  const { channel } = await api<{ channel: TeamChannelDto | null }>(
    `/api/team-chat/channels/${channelId}`,
  );
  return channel;
}

export async function listChannelMessages(
  channelId: string,
  opts: { take?: number; before?: string } = {},
): Promise<ChannelMessagesPage> {
  return api<ChannelMessagesPage>(`/api/team-chat/channels/${channelId}/messages`, {
    query: { take: opts.take, before: opts.before },
  });
}

export async function listChannelPins(channelId: string): Promise<ChannelPinDto[]> {
  const { pins } = await api<{ pins: ChannelPinDto[] }>(
    `/api/team-chat/channels/${channelId}/pins`,
  );
  return pins;
}

// ---------------------------------------------------------------------------
// WhatsApp settings + templates
// ---------------------------------------------------------------------------

export async function getTeamWhatsappConfig(): Promise<WhatsappConfigView> {
  const { config } = await api<{ config: WhatsappConfigView }>("/api/workspace/whatsapp");
  return config;
}

/** One connected account on a channel — a workspace may have several. */
export interface ChannelAccountView {
  id: string;
  channel: string;
  externalAccountId: string;
  label: string | null;
  isDefault: boolean;
  isActive: boolean;
  needsReconnect: boolean;
  displayPhoneNumber: string | null;
  wabaId: string | null;
  createdAt: string;
  /** WhatsApp only — per-number quality/throughput + the shared portfolio. */
  health: ChannelAccountHealth | null;
}

export interface ChannelAccountHealth {
  qualityRating: string | null;
  throughputLevel: string | null;
  updatedAt: string | null;
  portfolio: {
    externalId: string | null;
    messagingTier: string | null;
    messagingDailyCap: number | null;
    verificationStatus: string | null;
    templateLimit: number;
    accountCount: number;
  } | null;
}

export async function listChannelAccounts(
  channel: "whatsapp" | "messenger" | "instagram",
): Promise<ChannelAccountView[]> {
  const { accounts } = await api<{ accounts: ChannelAccountView[] }>(
    `/api/workspace/channels/${channel}/accounts`,
  );
  return accounts;
}

/**
 * Display-only view of every connected account, across all channels — what an
 * AGENT is allowed to see so the inbox can attribute a thread to the number /
 * Page / handle it arrived on. No credentials cross this boundary.
 */
export interface ChannelAccountDirectoryEntry {
  id: string;
  channel: Channel;
  name: string;
  providerName: string | null;
  isDefault: boolean;
  isActive: boolean;
}

export async function listChannelAccountDirectory(): Promise<ChannelAccountDirectoryEntry[]> {
  const { accounts } = await api<{ accounts: ChannelAccountDirectoryEntry[] }>(
    "/api/workspace/channel-accounts",
  );
  return accounts;
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
  needsReconnect: boolean;
  /** Live Page↔app webhook subscription; null when it couldn't be checked. */
  webhookSubscription: {
    receivesMessages: boolean;
    subscribedFields: string[];
    missingFields: string[];
  } | null;
}

export async function getTeamMessengerConfig(): Promise<MessengerConfigView> {
  const { config } = await api<{ config: MessengerConfigView }>("/api/workspace/messenger");
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
  needsReconnect: boolean;
  /** Live subscription of the LINKED PAGE (IG DMs ride it); null when unchecked. */
  webhookSubscription: {
    receivesMessages: boolean;
    subscribedFields: string[];
    missingFields: string[];
  } | null;
}

export async function getTeamInstagramConfig(): Promise<InstagramConfigView> {
  const { config } = await api<{ config: InstagramConfigView }>("/api/workspace/instagram");
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
  const { config } = await api<{ config: MetaConfigView }>("/api/workspace/meta");
  return config;
}

/** One website chat widget (a team runs many). Mirrors the API's WidgetView. */
export interface WebchatWidgetView {
  id: string;
  name: string;
  publicKey: string;
  allowedOrigins: string[];
  config: {
    theme?: { primaryColor?: string; launcherColor?: string; userBubbleColor?: string };
    welcomeMessage?: string;
    headerTitle?: string;
    headerSubtitle?: string;
    suggestedQuestions?: string[];
    preChatFields?: { id: string; label: string; type: "text" | "name" | "email" | "phone"; required: boolean }[];
    showBranding?: boolean;
    logoDataUrl?: string;
    agentAvatarDataUrl?: string;
    fontFamily?: "system" | "rounded" | "serif";
    themeMode?: "light" | "dark" | "auto";
    soundEnabled?: boolean;
    allowedMediaKinds?: Array<"image" | "video" | "audio" | "document">;
    awayMessage?: string;
    aiEnabled?: boolean;
    showHeader?: boolean;
    launcher?: "bubble" | "off" | "inline";
    position?: "right" | "left";
    launcherLabel?: string;
  };
  isActive: boolean;
  /** Host of the first real site that embedded this widget; null until observed. */
  firstSeenOrigin: string | null;
  conversationCount: number;
  createdAt: string;
}

export async function getTeamWebchatWidgets(): Promise<WebchatWidgetView[]> {
  const { widgets } = await api<{ widgets: WebchatWidgetView[] }>("/api/workspace/webchatwidget");
  return widgets;
}

export async function listWhatsappTemplates(): Promise<{
  templates: TemplateDto[];
  hasWabaId: boolean;
  hasAppId: boolean;
  connected: boolean;
}> {
  return api("/api/workspace/whatsapp/templates");
}

// ---------------------------------------------------------------------------
// Broadcasts
// ---------------------------------------------------------------------------

export interface BroadcastListItem {
  id: string;
  status: string;
  name: string | null;
  // freeform / People (customer-mode) broadcasts carry no template — null here.
  kind: "template" | "freeform";
  channel: string;
  targetMode: "contact" | "customer";
  scheduledAt: string | null;
  templateName: string | null;
  templateLanguage: string | null;
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
  templateId: string | null;
  bodyText: string | null;
  /** Retryable failures only (excludes cancel-finalized recipients). */
  genuineFailedCount: number;
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
  /** Scope to one channel, or `people` for omnichannel campaigns. */
  channel?: string;
  /** Numbered (offset) pagination — when set, the API returns `totalCount`. */
  page?: number;
  take?: number;
}): Promise<{ broadcasts: BroadcastListItem[]; totalCount?: number }> {
  const params = new URLSearchParams();
  if (opts?.status && opts.status !== "all") params.set("status", opts.status);
  if (opts?.search) params.set("search", opts.search);
  if (opts?.channel) params.set("channel", opts.channel);
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
  const { keys } = await api<{ keys: ApiKeyListItem[] }>("/api/workspace/api-keys");
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
    "/api/workspace/outbound-webhooks",
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
  const { workflows } = await api<{ workflows: WorkflowListItem[] }>("/api/workspace/workflows");
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
  assignmentPolicies: Array<{ id: string; name: string; isDefault: boolean }>;
}> {
  const [users, templates, tags, stages, fields, workflows, assignmentPolicies] =
    await Promise.all([
      listTeamMembers(),
      listWhatsappTemplates(),
      listTags(),
      listContactStages(),
      listContactFieldDefinitions(),
      listWorkflows(),
      listAssignmentPolicies(),
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
    assignmentPolicies,
  };
}

export async function getWorkflow(id: string): Promise<Record<string, unknown> | null> {
  try {
    return await api<Record<string, unknown>>(`/api/workspace/workflows/${id}`);
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
