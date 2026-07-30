/**
 * Saved TICKET views — a named, reusable filter over the board.
 *
 * The board's own controls (status column, priority chip, team queue) are
 * transient narrowings you toggle while working. A saved view is the query a
 * department lives in: "urgent + unclaimed", "shared with us and past due",
 * "everything waiting on Billing".
 *
 * ONE VALIDATED DOCUMENT, ONE WHERE-BUILDER. These criteria are stored as a
 * single JSON document and turned into SQL in exactly one place
 * (`apps/api/src/lib/tickets/views/where.ts`), which returns independent
 * predicates the caller ANDs in. That is the same rule the inbox views learned
 * the hard way three times: a filter merged by SPREAD lets an "Unassigned" view
 * silently clobber an agent's visibility restriction, or a guest's access gate.
 *
 * Every field is optional and additive. An empty document means "no narrowing",
 * which is what a freshly-created view does before you configure it.
 */

import type { TicketPriority, TicketStatus } from "./types";

export type TicketViewVisibility = "personal" | "shared";

/** Colour slots are named (never hex) so the UI maps to a Tailwind safelist. */
export const TICKET_VIEW_ICONS = [
  "filter",
  "inbox",
  "alert",
  "clock",
  "flame",
  "users",
  "tag",
  "star",
] as const;
export type TicketViewIcon = (typeof TICKET_VIEW_ICONS)[number];

export interface TicketViewFilters {
  status?: TicketStatus[];
  priority?: TicketPriority[];
  /**
   * `"me"` resolves to the viewing agent server-side, `"none"` means
   * unassigned. A raw id targets that teammate. Resolved at READ time, never
   * stored expanded — a view saved as "assigned to me" must mean the reader,
   * not whoever created it.
   */
  assignee?: string;
  /** `"none"` = owned by no team; a raw AssignmentPolicy id = that queue. */
  team?: string;
  tagIds?: string[];
  channel?: string;
  /** One channel account (`ChannelConnection.id`). */
  accountId?: string;
  /** Only tickets that missed a promise. */
  breachedOnly?: boolean;
  /** Only tickets another workspace escalated to us. */
  sharedWithUsOnly?: boolean;
  /** Only work nobody in this workspace has claimed yet. */
  untriagedOnly?: boolean;
  /** Free text — same matcher as the board's search box. */
  query?: string;
}

/** A saved view as every read path returns it. */
export interface TicketView {
  id: string;
  name: string;
  color: string;
  icon: string;
  visibility: TicketViewVisibility;
  filters: TicketViewFilters;
  position: number;
  createdById: string | null;
  /** True when the viewer may edit/delete it: its author, or any admin/manager
   *  for a SHARED view. Resolved server-side so the UI never offers a refused
   *  action. */
  canManage: boolean;
}

/**
 * Narrow an unknown JSON document to the filter shape.
 *
 * Tolerant by design: an unrecognised key is DROPPED rather than rejected, so a
 * view saved by a newer build degrades to the criteria this build understands
 * instead of failing the whole board read. The server still validates on WRITE
 * (Zod), which is where a malformed document should be refused.
 */
export function parseTicketViewFilters(raw: unknown): TicketViewFilters {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const o = raw as Record<string, unknown>;
  const strArray = (v: unknown): string[] | undefined => {
    if (!Array.isArray(v)) return undefined;
    const out = v.filter((x): x is string => typeof x === "string" && x.length > 0);
    return out.length > 0 ? out : undefined;
  };
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.length > 0 ? v : undefined;
  const bool = (v: unknown): boolean | undefined => (v === true ? true : undefined);

  const filters: TicketViewFilters = {};
  const status = strArray(o.status) as TicketStatus[] | undefined;
  if (status) filters.status = status;
  const priority = strArray(o.priority) as TicketPriority[] | undefined;
  if (priority) filters.priority = priority;
  const assignee = str(o.assignee);
  if (assignee) filters.assignee = assignee;
  const team = str(o.team);
  if (team) filters.team = team;
  const tagIds = strArray(o.tagIds);
  if (tagIds) filters.tagIds = tagIds;
  const channel = str(o.channel);
  if (channel) filters.channel = channel;
  const accountId = str(o.accountId);
  if (accountId) filters.accountId = accountId;
  if (bool(o.breachedOnly)) filters.breachedOnly = true;
  if (bool(o.sharedWithUsOnly)) filters.sharedWithUsOnly = true;
  if (bool(o.untriagedOnly)) filters.untriagedOnly = true;
  const query = str(o.query);
  if (query) filters.query = query.slice(0, 200);
  return filters;
}

/** Human summary for the view list ("Urgent · unclaimed · past due"). */
export function describeTicketViewFilters(f: TicketViewFilters): string {
  const parts: string[] = [];
  if (f.status?.length) parts.push(f.status.join(", "));
  if (f.priority?.length) parts.push(f.priority.join(", "));
  if (f.assignee === "me") parts.push("mine");
  else if (f.assignee === "none") parts.push("unassigned");
  else if (f.assignee) parts.push("one assignee");
  if (f.team === "none") parts.push("no team");
  else if (f.team) parts.push("one team");
  if (f.tagIds?.length) parts.push(`${f.tagIds.length} tag${f.tagIds.length === 1 ? "" : "s"}`);
  if (f.channel) parts.push(f.channel);
  if (f.breachedOnly) parts.push("past due");
  if (f.sharedWithUsOnly) parts.push("shared with us");
  if (f.untriagedOnly) parts.push("unclaimed");
  if (f.query) parts.push(`“${f.query}”`);
  return parts.length > 0 ? parts.join(" · ") : "No filters yet";
}
