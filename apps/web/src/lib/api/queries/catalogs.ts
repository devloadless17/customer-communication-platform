import "server-only";

import { cache } from "react";

import type { InboxView } from "@ccp/shared/inbox-views/types";

import { api } from "../../api-client";
import { isApiNotFound } from "./helpers";




import type {
  AudienceGroupDto,
} from "@ccp/shared/dtos";
import type {
  ContactFieldDefinition,
  ContactPanelBuiltins,
  ContactStage,
  MessageFlagDefinition,
  Tag,
  TagUsage,
} from "@ccp/shared/types";
import type { MessageFlagDefinitionWithUsage } from "@ccp/shared/message-flags/types";
import type {
  Ticket as TicketView,
  TicketEvent as TicketEventView,
  TicketFieldDefinition,
  TicketSlaPolicy,
  TicketThreadMessage,
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
// Catalogs (tags / snippets / stages / contact fields / audience groups)
// ---------------------------------------------------------------------------

// NOTE: cache tags removed 2026-05-19. Next 16's `revalidateTag` from the
// `/api/internal/revalidate` bridge wasn't reliably busting these fetch-cache
// entries — operators saw stale snippet / tag / stage / field lists for the
// full 60s window even after their own edits. Strip the cache so every RSC
// render hits NestJS fresh. Cost: ~5-15ms per call docker-network. Acceptable
// at pilot scale. Re-introduce a working cache layer once we trust the bust.
/** Org, its workspaces (with counts) and its members — Organization settings.
 *  `cache()`d for intra-request dedup like its siblings: the three
 *  /organization tabs each call it, and a layout-level component sharing a
 *  request with a page must not double the fan-out. (Cross-NAVIGATION
 *  freshness is deliberate — every RSC read is no-store, see the note above.) */
export const getOrganizationOverview = cache(
  async (): Promise<OrganizationOverview> => {
    return api<OrganizationOverview>("/api/workspaces/organization");
  },
);

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
export async function getTicket(id: string): Promise<{
  ticket: TicketView;
  events: TicketEventView[];
  /** The cross-department conversation, oldest first. */
  thread: TicketThreadMessage[];
  /** THIS workspace's private notes — never another department's. */
  notes: TicketEventView[];
  /** Where this reader's "New replies" divider goes, or null. */
  threadUnreadSinceMessageId: string | null;
}> {
  return api(`/api/tickets/${id}`);
}

/** Which workspace of the caller's org holds this ticket id (access-gated). */
export async function locateTicket(
  id: string,
): Promise<{ workspaceId: string; workspaceName: string; number: number }> {
  return api<{ workspaceId: string; workspaceName: string; number: number }>(
    `/api/tickets/${id}/locate`,
  );
}

/** Sibling workspaces a ticket can be escalated to (id + name only). */
export async function listEscalationTargets(): Promise<Array<{ id: string; name: string }>> {
  const { workspaces } = await api<{ workspaces: Array<{ id: string; name: string }> }>(
    "/api/tickets/escalation-targets",
  );
  return workspaces;
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

/** Per-tag `{ contacts, views }` — two numbers, never summed (see TagsService.usage). */
export async function getTagUsage(): Promise<Record<string, TagUsage>> {
  const { usage } = await api<{ usage: Record<string, TagUsage> }>("/api/workspace/tags/usage");
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

/**
 * `cache`d like the stage/tag catalogs: the inbox LAYOUT now loads it for the
 * view builder's field criteria, and pages that also need it (contacts) should
 * dedupe within the same render.
 */
export const listContactFieldDefinitions = cache(
  async (): Promise<ContactFieldDefinition[]> => {
    const { definitions } = await api<{ definitions: ContactFieldDefinition[] }>(
      "/api/workspace/contact-fields",
    );
    return definitions;
  },
);

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

