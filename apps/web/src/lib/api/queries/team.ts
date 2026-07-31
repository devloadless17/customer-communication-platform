import "server-only";

import { cache } from "react";


import { api } from "../../api-client";
import type {
  Role,
  User,
} from "@ccp/shared/types";

/**
 * Inline DTOs that the API ships but apps/api defines locally in its
 * service files. Kept here (not in @ccp/shared) because the source-of-truth
 * lives next to the controller; this is just the consumer-side mirror so
 * web pages can name the response shape.
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

