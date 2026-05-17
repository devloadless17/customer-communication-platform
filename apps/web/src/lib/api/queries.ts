import "server-only";

import type { WorkflowTriggerEvent } from "@prisma/client";

import { api } from "../api-client";
import type {
  AudienceGroupDto,
  ListContactsOpts,
  MessageSearchPage,
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
  ContactStage,
  ConversationWithRefs,
  CursorPage,
  Message,
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

export async function getCurrentTeam(): Promise<{ id: string; name: string }> {
  const { team } = await api<{ team: { id: string; name: string } }>("/api/team");
  return team;
}

export async function listTeamMembers(): Promise<User[]> {
  const { users } = await api<{ users: User[] }>("/api/users");
  return users;
}

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

// ---------------------------------------------------------------------------
// Catalogs (tags / snippets / stages / contact fields / audience groups)
// ---------------------------------------------------------------------------

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

export async function listContactStages(): Promise<ContactStage[]> {
  const { stages } = await api<{ stages: ContactStage[] }>("/api/team/stages");
  return stages;
}

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

export async function listConversations(
  opts: ListConversationsOpts = {},
): Promise<CursorPage<ConversationWithRefs>> {
  return api<CursorPage<ConversationWithRefs>>("/api/conversations", {
    query: {
      take: opts.take,
      cursor: opts.cursor ?? undefined,
      search: opts.search ?? undefined,
    },
  });
}

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

export async function searchConversationMessages(
  conversationId: string,
  opts: { query: string; take?: number; cursor?: string | null },
): Promise<MessageSearchPage> {
  return api<MessageSearchPage>(`/api/conversations/${conversationId}/messages/search`, {
    query: {
      q: opts.query,
      take: opts.take,
      cursor: opts.cursor ?? undefined,
    },
  });
}

export async function loadMessageContextWindow(
  conversationId: string,
  opts: { around: string; take?: number },
): Promise<{ items: Message[]; nextOlderCursor: string | null; nextNewerCursor: string | null }> {
  return api(`/api/conversations/${conversationId}/messages/context`, {
    query: { around: opts.around, take: opts.take },
  });
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

export async function listBroadcasts(): Promise<BroadcastListItem[]> {
  const { broadcasts } = await api<{ broadcasts: BroadcastListItem[] }>("/api/broadcasts");
  return broadcasts;
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
}

export async function listApiKeys(): Promise<ApiKeyListItem[]> {
  const { keys } = await api<{ keys: ApiKeyListItem[] }>("/api/team/api-keys");
  return keys;
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

export interface WorkflowListItem {
  id: string;
  name: string;
  enabled: boolean;
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
