/**
 * DTOs returned by the read-side queries that span the apps/web ↔ apps/api
 * package boundary. These started life inside `apps/api/src/lib/queries/*` —
 * they're hoisted here so apps/web client components + the post-Step-7b
 * HTTP-driven RSC pages can name the shape without reaching across the
 * monorepo via a tsconfig shim.
 *
 * Pure types only — no runtime, no DB access, no `server-only` guard. The
 * query files in apps/api re-export from here so the wire-shape stays
 * single-sourced.
 */

import type {
  Channel,
  ContactFieldDefinition,
  MediaKind,
  MessageDirection,
  Role,
  OrgRole,
  OrgStatus,
} from "./types";

// ---------------------------------------------------------------------------
// Audience groups — saved named lists used by broadcasts.
// ---------------------------------------------------------------------------

export interface AudienceGroupDto {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  tagIds: string[];
  /**
   * Manually-added member ids. ALWAYS COMPLETE, from both the list and the
   * single-group read, and it must stay that way — two separate consumers
   * break silently if it is truncated:
   *   - the group edit form saves `contactIds` as a FULL REPLACE, so a
   *     truncated list would delete every member past the cut on save;
   *   - the broadcast composer reconstructs a group's audience from these ids
   *     to show the recipient count and preview on the Review step, so a
   *     truncated list understates the size of a billed, irreversible send.
   * Bounded by the write schema, which caps manual members at 5000.
   */
  contactIds: string[];
  /** Exact count of manual members, soft-deleted excluded. Equals
   *  `contactIds.length`; kept as its own field so callers that only need the
   *  number don't imply a dependency on the id array staying complete. */
  manualContactCount: number;
  /** Computed member count at read time: manual ∪ tag-matched, deduped. */
  memberCount: number;
  /** Null when the creator was hard-deleted; UI shows "Removed user". */
  createdById: string | null;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Super-admin: cross-team browse. Aggregates only — superAdmin visibility
// never crosses into customer message bodies (see the query file's note).
// ---------------------------------------------------------------------------

export interface SuperAdminWorkspaceRow {
  id: string;
  name: string;
  createdAt: string;
  /** Org-approval lifecycle — drives the approve/suspend controls + the
   *  pending-review queue on the platform Organizations page. */
  /** Parent organisation — the platform list groups workspaces under it. */
  organizationId: string;
  status: OrgStatus;
  /** Operator note attached on suspension (or rejection). Null while active. */
  statusReason: string | null;
  /** When the status was last changed by a super-admin. Null if never. */
  statusUpdatedAt: string | null;
  whatsappConnected: boolean;
  whatsappDisplayNumber: string | null;
  userCount: number;
  /** Hard cap on ACTIVE member accounts. Default 2; only a superAdmin raises it. */
  /** Seat cap for THIS workspace (super-admin controlled, default 2). */
  maxMembers: number;
  /** How many workspaces the owning ORGANISATION may create (default 2). */
  maxWorkspaces: number;
  /** How many it currently has — only populated on the detail view. */
  workspaceCount?: number;
  contactCount: number;
  conversationCount: number;
  messageCount: number;
  broadcastCount: number;
}

/**
 * One ORGANISATION on the platform, with the workspaces it owns.
 *
 * The platform list is org-first because that is what the platform actually
 * administers: approval status, the workspace cap and the billing relationship
 * all live on the organisation. It used to list WORKSPACES under an
 * "Organizations" heading, which showed workspace ids and made a two-workspace
 * customer look like two customers.
 */
export interface SuperAdminOrgRow {
  id: string;
  name: string;
  createdAt: string;
  status: OrgStatus;
  statusReason: string | null;
  statusUpdatedAt: string | null;
  /** How many workspaces it may create (super-admin controlled, default 2). */
  maxWorkspaces: number;
  /** Distinct people across all its workspaces — a person in two workspaces
   *  counts once, which is what "how big is this customer" means. */
  memberCount: number;
  /** Totals summed over its workspaces. */
  contactCount: number;
  conversationCount: number;
  messageCount: number;
  workspaces: SuperAdminWorkspaceRow[];
}

export interface SuperAdminWorkspaceDetail {
  workspace: SuperAdminWorkspaceRow;
  members: Array<{
    id: string;
    name: string;
    email: string;
    /** Role in THIS workspace. Only meaningful when `inWorkspace` is true. */
    role: Role;
    /**
     * Whether this person has joined the workspace being viewed. The roster is
     * ORG-wide (User hangs off Organization), so it also carries members who
     * belong to no workspace at all — someone removed from their last one, or a
     * social signup whose workspace seeding failed. Filtering those out is what
     * previously made them invisible to the only screen that can manage them.
     */
    inWorkspace: boolean;
    /** Org-level role — what to show for someone with no workspace access. */
    orgRole: OrgRole;
    // Platform operator co-located into this org — excluded from seat counts.
    isSuperAdmin: boolean;
    deactivatedAt: string | null;
    createdAt: string;
  }>;
}

// ---------------------------------------------------------------------------
// Platform analytics — super-admin overview. Cross-team aggregates only.
// ---------------------------------------------------------------------------

export interface PlatformAnalytics {
  orgs: {
    total: number;
    pending: number;
    active: number;
    suspended: number;
  };
  totals: {
    users: number;
    contacts: number;
    conversations: number;
    messages: number;
    broadcasts: number;
  };
  /** Orgs created in the trailing 30 days (signup momentum). */
  newOrgsLast30d: number;
  /** The current approval queue — newest first, capped for the overview card. */
  pendingOrgs: Array<{ id: string; name: string; createdAt: string }>;
}

/**
 * Operational snapshot for the super-admin Platform page
 * (`GET /api/admin/analytics/ops`). The durable half — per-queue counts read
 * from Redis — survives api restarts, unlike the in-process
 * `jobFailuresSinceBoot` counters, which is exactly why both are shown.
 */
export interface PlatformOpsSnapshot {
  db: boolean;
  redis: boolean;
  uptimeSec: number;
  /** Breached health thresholds — empty when healthy (mirrors /health). */
  degraded: string[];
  outboxLag: { pendingCount: number; oldestPendingSec: number | null; stale: boolean };
  /** queue name → counts; null = that probe failed/timed out. */
  queues: Record<
    string,
    { failed: number; waiting: number; delayed: number; active: number } | null
  >;
  jobFailuresSinceBoot: Record<
    string,
    { failedLastHour: number; failedTotal: number; lastError?: string; lastFailureAt?: string }
  >;
}

// ---------------------------------------------------------------------------
// Workspace performance report (`GET /api/reports/overview`, /v1 parity at
// `GET /v1/reports/overview`). Metric definitions live on
// apps/api/src/lib/analytics/reports.ts — durations in SECONDS, null when the
// range holds no qualifying rows (render as "—", never as 0: "no data" and
// "instant" must not look alike).
// ---------------------------------------------------------------------------

export interface WorkspaceReport {
  range: {
    from: string;
    to: string;
    tz: string;
    /** The account every panel was scoped to, or null for the whole workspace. */
    accountId: string | null;
  };
  volume: {
    inbound: number;
    outbound: number;
    conversationsOpened: number;
    conversationsClosed: number;
    /** Per-day buckets in the requested timezone; days with no traffic are
     *  absent (the chart fills gaps client-side). */
    daily: Array<{ day: string; inbound: number; outbound: number }>;
  };
  channels: Array<{ channel: string; inbound: number; outbound: number }>;
  /**
   * Volume per ACCOUNT — which specific number / Page / handle did the work.
   *
   * Finer than `channels`, and the grain an operator running two numbers on one
   * medium actually asks about. `accountId: null` = traffic whose account can't
   * be resolved (a since-disconnected number); reported rather than dropped.
   * `name` is the account's label, else its provider id — null when the account
   * row is gone.
   */
  accounts: Array<{
    accountId: string | null;
    channel: string;
    name: string | null;
    inbound: number;
    outbound: number;
  }>;
  firstResponse: {
    answeredConversations: number;
    avgSec: number | null;
    medianSec: number | null;
  };
  resolution: {
    closedConversations: number;
    avgSec: number | null;
    medianSec: number | null;
  };
  agents: Array<{
    userId: string;
    /** Resolved at read time; null = the member has since left the workspace. */
    name: string | null;
    messagesSent: number;
    conversationsClosed: number;
    answeredConversations: number;
    medianFirstResponseSec: number | null;
  }>;
  sla: {
    ticketsCreated: number;
    firstResponse: { withSla: number; breached: number };
    resolution: { withSla: number; breached: number };
  };
  ai: {
    aiMessages: number;
    aiConversations: number;
    /** Threads whose every outbound in range was AI (broadcasts excluded). */
    aiOnlyConversations: number;
  };
}

// ---------------------------------------------------------------------------
// Team performance report (`GET /api/reports/team`, /v1 parity at
// `GET /v1/reports/team`). Metric definitions live on
// apps/api/src/lib/analytics/team-report.ts — durations in SECONDS, null when
// the range holds no qualifying rows (render as "—", never as 0).
//
// `accountId` scope applies ONLY to message/conversation metrics — Call,
// Ticket and InternalNote carry no account column, so those blocks always
// cover the whole workspace regardless of scope.
// ---------------------------------------------------------------------------

export interface TeamReportDaily {
  /** YYYY-MM-DD in the requested timezone; days with no activity are absent
   *  (the chart fills gaps client-side). */
  day: string;
  messagesSent: number;
  conversationsClosed: number;
}

export interface TeamReportAgent {
  userId: string;
  /** Resolved at read time; null = the member has since left the workspace. */
  name: string | null;
  /** Null for departed members (no roster row to read from). */
  email: string | null;
  role: Role | null;
  deactivated: boolean;
  conversations: {
    /** Assignment events TO this agent in range (audit ledger — counts
     *  reassignments, not just first assignment). */
    assigned: number;
    closed: number;
    /** Point-in-time: open conversations currently assigned (ignores range). */
    openNow: number;
    /** Conversations created in range this agent answered first. */
    firstReplies: number;
    avgFirstResponseSec: number | null;
    medianFirstResponseSec: number | null;
    avgResolutionSec: number | null;
    medianResolutionSec: number | null;
  };
  messages: {
    /** Outbound authored in range; broadcast blasts excluded. */
    sent: number;
    notesAuthored: number;
  };
  calls: {
    placed: number;
    answered: number;
    talkTimeTotalSec: number;
    talkTimeAvgSec: number | null;
  };
  tickets: {
    created: number;
    resolved: number;
    /** Point-in-time: open tickets currently assigned (ignores range). */
    openAssignedNow: number;
    /** SLA breach flags among tickets this agent RESOLVED in range — one
     *  attribution rule (the resolver), one time anchor (resolvedAt). */
    firstResponseBreached: number;
    resolutionBreached: number;
  };
  /**
   * Minutes online over the range, summed from the 5-minute presence sampler's
   * UTC-day ledger (AgentPresenceDaily). Null = NO samples for this agent in
   * range — "not tracked" (e.g. before the sampler shipped) must not render as
   * "0h online". Day-granular: a range starting at a browser's local midnight
   * is approximated to the covered UTC days.
   */
  onlineMinutes: number | null;
}

/**
 * Per-assignment-team rollup — the same range's activity summed over each
 * team's members (a user on two teams counts in both; that is what "team
 * output" means, not double-billing). `teamId: null` is the "No team" bucket
 * for members outside every team. Medians deliberately absent: they don't
 * sum, and a per-team median is a different query this panel doesn't need.
 */
export interface TeamReportTeamRollup {
  teamId: string | null;
  name: string;
  memberCount: number;
  assigned: number;
  closed: number;
  messagesSent: number;
  callsAnswered: number;
  talkTimeTotalSec: number;
  ticketsResolved: number;
}

export interface TeamReport {
  range: {
    from: string;
    to: string;
    tz: string;
    accountId: string | null;
  };
  totals: {
    messagesSent: number;
    notesAuthored: number;
    conversationsAssigned: number;
    conversationsClosed: number;
    callsPlaced: number;
    callsAnswered: number;
    /** Workspace-level only — a missed call rings the team, not one agent. */
    callsMissed: number;
    talkTimeTotalSec: number;
    ticketsCreated: number;
    ticketsResolved: number;
    /** Workspace-level first response over conversations created in range —
     *  the same numbers as WorkspaceReport.firstResponse (medians don't sum,
     *  so this cannot be derived from the per-agent rows). */
    firstResponse: {
      answeredConversations: number;
      avgSec: number | null;
      medianSec: number | null;
    };
  };
  daily: TeamReportDaily[];
  /** Unsorted contract — the client owns column sorting. */
  agents: TeamReportAgent[];
  /**
   * Inbound demand by (day-of-week, hour) in the requested timezone — the
   * busiest-hours heatmap behind staffing decisions. `dow` follows Postgres
   * EXTRACT(dow): 0 = Sunday. Cells with no traffic are absent.
   */
  heatmap: Array<{ dow: number; hour: number; inbound: number }>;
  /** Empty when the workspace has no assignment teams (the panel hides). */
  teams: TeamReportTeamRollup[];
}

export interface TeamReportAgentDetail extends TeamReportAgent {
  /** This agent's own per-day series over the same range. */
  daily: TeamReportDaily[];
}

/** Point-in-time snapshot for the live "now" strip (`GET /api/reports/team/live`). */
export interface TeamLiveSnapshot {
  generatedAt: string;
  agents: Array<{
    userId: string;
    /** Open conversations currently assigned. */
    openAssigned: number;
    /** Calls currently ringing or in progress attributed to this agent. */
    activeCalls: number;
  }>;
}

// ---------------------------------------------------------------------------
// In-conversation message search.
// ---------------------------------------------------------------------------

export interface MessageSearchHit {
  id: string;
  body: string;
  direction: MessageDirection;
  timestamp: string;
  /** Authoring teammate's name on outbound, null on inbound. */
  senderName: string | null;
  /** mediaCaption when this is a media message, undefined otherwise. */
  mediaCaption?: string;
  mediaKind?: MediaKind;
}

export interface MessageSearchPage {
  items: MessageSearchHit[];
  nextCursor: string | null;
  totalMatched: number;
}

// ---------------------------------------------------------------------------
// Global inbox search (the tabbed search bar over the conversation list).
// Three scopes — contacts / messages / notes — each ILIKE-matched team-wide
// (NOT scoped to one conversation, unlike MessageSearchHit above). Every hit
// carries enough context to render a row AND to open the right conversation:
// `conversationId` is what the inbox opens, plus a `messageId` on message/note
// hits so the thread can jump straight to the match.
// ---------------------------------------------------------------------------

export type InboxSearchScope = "contacts" | "messages" | "notes";

/** A contact match — opens that contact's conversation (one-per-contact). */
/** One channel a person is reachable on — for the search row's badge cluster. */
export interface ContactSearchChannel {
  contactId: string;
  channel: Channel;
  /** Null when that channel-contact has never had a conversation. */
  conversationId: string | null;
}

export interface ContactSearchHit {
  contactId: string;
  /** Null when the contact has never had a conversation (manually added,
   *  never messaged). The UI renders these as "start a chat" rather than
   *  "open thread". */
  conversationId: string | null;
  name: string;
  phoneNumber: string | null;
  /** The channel this contact identity lives on — drives the row's channel
   *  badge so a WhatsApp vs Messenger vs Instagram result is distinguishable. */
  channel: Channel;
  /**
   * Every channel the SAME PERSON (unified Customer) is reachable on, including
   * the matched one — so a person who has chatted on WhatsApp + Messenger + IG
   * appears ONCE with a badge cluster you can click to jump to any channel's
   * thread, instead of as N duplicate rows. Length ≥ 1 (the matched contact).
   */
  channels: ContactSearchChannel[];
  avatarUrl?: string;
  /** Which field actually matched, so the row can show the matched value
   *  (e.g. an email hit shows the email, not just the name). */
  matchedField: "name" | "phone" | "email";
  /** The value of the matched field, for the snippet line. */
  matchedValue: string;
}

/** A message match anywhere in the team — opens its conversation + jumps. */
export interface GlobalMessageHit {
  messageId: string;
  conversationId: string;
  /** Contact name on the conversation, for the row header. */
  contactName: string;
  contactAvatarUrl?: string;
  /** The matched message `body`, trimmed for display. Media captions are
   *  copied into `body` at every write site, so a single `body` snippet
   *  always carries the matched text (see global-search.ts searchAllMessages). */
  snippet: string;
  direction: MessageDirection;
  timestamp: string;
  mediaKind?: MediaKind;
}

/** An internal-note match — opens the conversation it's attached to. */
export interface NoteSearchHit {
  noteId: string;
  conversationId: string;
  contactName: string;
  contactAvatarUrl?: string;
  /** The note author's name, null when the author was removed. */
  authorName: string | null;
  snippet: string;
  timestamp: string;
}

export interface ContactSearchPage {
  items: ContactSearchHit[];
  nextCursor: string | null;
}
export interface GlobalMessageSearchPage {
  items: GlobalMessageHit[];
  nextCursor: string | null;
}
export interface NoteSearchPage {
  items: NoteSearchHit[];
  nextCursor: string | null;
}

// ---------------------------------------------------------------------------
// Contacts list — request-side options. Response shape is `CursorPage<ContactListItem>`
// from ./types (already there).
// ---------------------------------------------------------------------------

export interface ListContactsOpts {
  /** Free-text search across name, phone, email, and customField values. */
  search?: string;
  /** Filter rows where customFields[key] matches value. Default mode is
   *  case-insensitive `contains` (text fields); `equals` is an exact match —
   *  the UI sends it with an option ID for select-type fields. */
  fieldFilter?: { key: string; value: string; mode?: "contains" | "equals" };
  /** Filter by how the contact got into the DB. */
  source?: "inbound" | "manual";
  /** Keep only contacts carrying ANY of these tag ids (union, like audience groups). */
  tagIds?: string[];
  /** Filter to one channel identity (whatsapp / messenger / instagram). */
  channel?: Channel;
  /**
   * Filter to ONE account on that channel — "who writes to the Sales number".
   * A workspace can hold several numbers / Pages / handles per channel, so
   * `channel` alone cannot express this; the inbox has had the same filter for
   * a while and the contacts directory could not answer it at all.
   *
   * Matched through the CONVERSATION, which is the single owner of a thread's
   * account (contacts themselves carry no account column, deliberately).
   */
  accountId?: string;
  /** Roll the list up to one row per unified PERSON (a `Customer`, or a solo
   *  contact as its own person) instead of one row per channel-contact — the
   *  contacts-page "Group by person" view. Runs in offset/page mode; the
   *  channel filter is ignored (a person spans channels). */
  groupByPerson?: boolean;
  /** Filter by 24h customer-service window: "open" = messaged us in the last
   *  24h; "closed" = no inbound, or last inbound > 24h ago. */
  window?: "open" | "closed";
  /** Filter to contacts currently parked in this stage. `"none"` matches
   *  contacts with no stage at all (orphaned after a stage delete). */
  stageId?: string | "none";
  cursor?: string | null;
  take?: number;
  /** 1-based page for numbered (offset) pagination. When set, the query runs
   *  in offset mode: `cursor` is ignored, `totalCount` is always returned, and
   *  `nextCursor` is null. Omit for the legacy keyset/infinite-scroll mode. */
  page?: number;
}

// ---------------------------------------------------------------------------
// WhatsApp settings — current Meta config view shipped to the admin
// pre-fill form. Plain values (decrypted server-side), display-only.
// ---------------------------------------------------------------------------

/**
 * Channel-member row for the members panel. Mirrors the underlying
 * `TeamChannelMember` join with the user fields denormalized so the panel
 * can render without a second round-trip.
 */
export interface ChannelMemberDto {
  channelId: string;
  userId: string;
  name: string;
  email: string;
  role: import("./types").Role;
  avatarUrl: string | null;
  /** ISO. Useful sorting in the list ("most-recently-added first"). */
  addedAt: string;
  /** Null when the adding admin has been removed (FK SetNull). */
  addedById: string | null;
  /** True when the row represents the current viewer, so the UI can render
   *  a "Leave" affordance instead of "Remove" + treat it specially. */
  isSelf: boolean;
}

export interface WhatsappConfigView {
  phoneNumberId: string | null;
  displayPhoneNumber: string | null;
  wabaId: string | null;
  appId: string | null;
  verifyToken: string | null;
  /** Decrypted plaintext — wire path is server→browser only, never client→server. */
  accessToken: string | null;
  appSecret: string | null;
  /** True when secrets are present in the DB but decrypt failed (key rotated,
   *  envelope corrupt). Page surfaces this so admin can re-paste. */
  credentialsUndecryptable: boolean;
  /** True when a send failed with Graph 190 (token expired/revoked) — drives the
   *  Settings "reconnect" banner, consistent with Messenger/Instagram. */
  needsReconnect: boolean;
  /** WhatsApp messaging-limit tier (e.g. "TIER_10K") — how many unique customers
   *  the number may message per 24h. Null when not yet known. Drives the composer
   *  "remaining daily allowance" hint + Settings health row. */
  messagingTier: string | null;
  /** Derived numeric 24h unique-recipient cap for the tier (null = unlimited/unknown). */
  messagingDailyCap: number | null;
  /** Quality band: "GREEN" | "YELLOW" | "RED" | null. */
  qualityRating: string | null;
  /** Throughput level: "STANDARD" | "HIGH" | null. */
  throughputLevel: string | null;
}

// Re-export commonly co-imported types so callers can grab everything from
// one path when they want to.
export type { ContactFieldDefinition };
