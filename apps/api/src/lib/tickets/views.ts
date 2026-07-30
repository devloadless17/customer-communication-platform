import type { PrismaClient } from "@prisma/client";

import type { TicketView, TicketViewFilters } from "@ccp/shared/tickets/views";
import { parseTicketViewFilters } from "@ccp/shared/tickets/views";

import type { ListTicketsFilters } from "./queries";

/**
 * Saved ticket views — CRUD, and the ONE place a stored criteria document
 * becomes list filters.
 *
 * `ticketViewToFilters` returns a `ListTicketsFilters` the caller merges into
 * its own read. It does NOT build a Prisma `where` itself: `listTickets`
 * already composes every filter as an AND element behind the access gate, so
 * routing a view through it inherits both properties for free. The alternative
 * — a second where-builder for views — is exactly how the inbox learned this
 * lesson three times: a filter object merged by spread silently overwrote an
 * agent's visibility restriction.
 */

type Db = Pick<PrismaClient, "ticketView">;

const VIEW_SELECT = {
  id: true,
  name: true,
  color: true,
  icon: true,
  visibility: true,
  filters: true,
  position: true,
  createdById: true,
} as const;

type ViewRow = {
  id: string;
  name: string;
  color: string;
  icon: string;
  visibility: "personal" | "shared";
  filters: unknown;
  position: number;
  createdById: string | null;
};

/** Who may edit or delete a view: its author, or any admin/manager for a
 *  SHARED one (team configuration is theirs to curate). */
function canManage(row: ViewRow, viewerUserId: string, role: string): boolean {
  if (row.createdById === viewerUserId) return true;
  return row.visibility === "shared" && (role === "admin" || role === "manager");
}

function mapView(row: ViewRow, viewerUserId: string, role: string): TicketView {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    icon: row.icon,
    visibility: row.visibility,
    filters: parseTicketViewFilters(row.filters),
    position: row.position,
    createdById: row.createdById,
    canManage: canManage(row, viewerUserId, role),
  };
}

/**
 * Views visible to this agent: every SHARED one in the workspace, plus their
 * OWN personal ones. A colleague's personal view is theirs alone — that is what
 * "personal" means, and listing it would make the distinction cosmetic.
 */
export async function listTicketViews(
  db: Db,
  workspaceId: string,
  viewerUserId: string,
  role: string,
): Promise<TicketView[]> {
  const rows = await db.ticketView.findMany({
    where: {
      workspaceId,
      OR: [{ visibility: "shared" }, { visibility: "personal", createdById: viewerUserId }],
    },
    orderBy: [{ visibility: "asc" }, { position: "asc" }, { name: "asc" }],
    select: VIEW_SELECT,
  });
  return rows.map((r) => mapView(r, viewerUserId, role));
}

export type SaveViewOutcome =
  | { ok: true; view: TicketView }
  | { ok: false; reason: "name_taken" }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "forbidden" };

export async function createTicketView(
  db: Db,
  args: {
    workspaceId: string;
    viewerUserId: string;
    role: string;
    name: string;
    color?: string;
    icon?: string;
    visibility: "personal" | "shared";
    filters: TicketViewFilters;
  },
): Promise<SaveViewOutcome> {
  try {
    const row = await db.ticketView.create({
      data: {
        workspaceId: args.workspaceId,
        name: args.name,
        ...(args.color ? { color: args.color } : {}),
        ...(args.icon ? { icon: args.icon } : {}),
        visibility: args.visibility,
        createdById: args.viewerUserId,
        filters: { ...args.filters },
      },
      select: VIEW_SELECT,
    });
    return { ok: true, view: mapView(row, args.viewerUserId, args.role) };
  } catch (err) {
    // The two case-insensitive partial uniques (shared / personal). Reported as
    // a conflict rather than a 500: "you already have a view called that" is
    // the actionable message.
    if (isUniqueViolation(err)) return { ok: false, reason: "name_taken" };
    throw err;
  }
}

export async function updateTicketView(
  db: Db,
  args: {
    workspaceId: string;
    viewerUserId: string;
    role: string;
    id: string;
    name?: string;
    color?: string;
    icon?: string;
    visibility?: "personal" | "shared";
    filters?: TicketViewFilters;
    position?: number;
  },
): Promise<SaveViewOutcome> {
  const existing = await db.ticketView.findFirst({
    where: { id: args.id, workspaceId: args.workspaceId },
    select: VIEW_SELECT,
  });
  if (!existing) return { ok: false, reason: "not_found" };
  if (!canManage(existing, args.viewerUserId, args.role)) return { ok: false, reason: "forbidden" };

  try {
    const row = await db.ticketView.update({
      where: { id: args.id },
      data: {
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(args.color !== undefined ? { color: args.color } : {}),
        ...(args.icon !== undefined ? { icon: args.icon } : {}),
        ...(args.visibility !== undefined ? { visibility: args.visibility } : {}),
        ...(args.filters !== undefined ? { filters: { ...args.filters } } : {}),
        ...(args.position !== undefined ? { position: args.position } : {}),
      },
      select: VIEW_SELECT,
    });
    return { ok: true, view: mapView(row, args.viewerUserId, args.role) };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, reason: "name_taken" };
    throw err;
  }
}

export async function deleteTicketView(
  db: Db,
  args: { workspaceId: string; viewerUserId: string; role: string; id: string },
): Promise<{ ok: true } | { ok: false; reason: "not_found" | "forbidden" }> {
  const existing = await db.ticketView.findFirst({
    where: { id: args.id, workspaceId: args.workspaceId },
    select: VIEW_SELECT,
  });
  if (!existing) return { ok: false, reason: "not_found" };
  if (!canManage(existing, args.viewerUserId, args.role)) return { ok: false, reason: "forbidden" };
  await db.ticketView.delete({ where: { id: args.id } });
  return { ok: true };
}

/** The stored view a board read is being scoped by, or null. */
export async function getTicketViewFilters(
  db: Db,
  workspaceId: string,
  viewerUserId: string,
  id: string,
): Promise<TicketViewFilters | null> {
  const row = await db.ticketView.findFirst({
    // Scoped to what the viewer may SEE, not just the workspace: a personal
    // view id belonging to a colleague must not scope someone else's board.
    where: {
      id,
      workspaceId,
      OR: [{ visibility: "shared" }, { visibility: "personal", createdById: viewerUserId }],
    },
    select: { filters: true },
  });
  return row ? parseTicketViewFilters(row.filters) : null;
}

/**
 * A saved view's criteria → list filters.
 *
 * `assignee: "me"` resolves to the READER, never to whoever saved the view —
 * a shared "Assigned to me" board has to mean each agent's own work, or it is
 * one person's board wearing a team's name.
 */
export function ticketViewToFilters(
  filters: TicketViewFilters,
  viewerUserId: string,
): ListTicketsFilters {
  const out: ListTicketsFilters = {};
  if (filters.status?.length) out.status = filters.status;
  if (filters.priority?.length) out.priority = filters.priority;
  if (filters.assignee !== undefined) {
    out.assignedUserId =
      filters.assignee === "me" ? viewerUserId : filters.assignee === "none" ? null : filters.assignee;
  }
  if (filters.team !== undefined) {
    out.assignedTeamId = filters.team === "none" ? null : filters.team;
  }
  if (filters.tagIds?.length) out.tagIds = filters.tagIds;
  if (filters.channel) out.channel = filters.channel;
  if (filters.accountId) out.accountId = filters.accountId;
  if (filters.breachedOnly) out.breachedOnly = true;
  if (filters.sharedWithUsOnly) out.sharedWithUsOnly = true;
  if (filters.untriagedOnly) out.untriagedOnly = true;
  if (filters.query) out.query = filters.query;
  return out;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "P2002"
  );
}
