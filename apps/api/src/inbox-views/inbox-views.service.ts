import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";

import {
  DEFAULT_INBOX_VIEW_ICON,
  MAX_INBOX_VIEWS_PER_SCOPE,
  inboxViewIsViewerScoped,
  type InboxView,
  type InboxViewFilters,
  type InboxViewVisibility,
} from "@ccp/shared/inbox-views/types";
import { resolvePermissions } from "@ccp/shared/auth/permissions";
import type { Role } from "@ccp/shared/types";

import { DbService } from "../db/db.service";
import { actorNameMasker } from "@/lib/workspaces/operator-mask";
import { EventBus } from "../events/event-bus.module";
import type {
  CreateInboxViewInput,
  ReorderInboxViewsInput,
  UpdateInboxViewInput,
} from "./inbox-views.schemas";

/**
 * Saved inbox views — CRUD, plus the counts the sidebar badges read.
 *
 * Two rules carry most of the weight here:
 *
 * 1. VISIBILITY IS A READ BOUNDARY, not a UI hint. Every read is
 *    `shared OR (personal AND mine)`, expressed as one OR inside the
 *    workspace-scoped where — never "fetch all, filter in JS". A personal view
 *    names the teammates and tags one agent watches; it is not another agent's
 *    business.
 *
 * 2. EDITABILITY IS COMPUTED SERVER-SIDE (`isEditable`). The rule — "mine, or
 *    shared and I hold inboxViews:manageShared" — depends on capabilities the
 *    client would have to re-derive, and a wrong guess renders an edit button
 *    that 403s. Every mutation re-checks it regardless; the flag only decides
 *    what to draw.
 */
/**
 * Who is acting on views.
 *
 * Deliberately NOT `ApiSession`: the /v1 API reaches these same rules with an
 * API key, which has a workspace but no user. Modelling the actor explicitly
 * keeps one implementation of "what may I see, what may I write" instead of a
 * parallel external copy that would drift — and it makes the `userId: null`
 * case impossible to forget, because every branch has to handle it.
 */
export interface InboxViewActor {
  workspaceId: string;
  /**
   * `null` for an API key. Such an actor has no PERSONAL views (it isn't a
   * person), and a view whose assignee is `me` resolves to nothing for it —
   * the loud-failure choice made in lib/inbox-views/where.ts.
   */
  userId: string | null;
  canManageShared: boolean;
}

/** Build an actor from a signed-in session. */
export function actorFromSession(session: {
  workspaceId: string;
  userId: string;
  role: Role;
  rolePermissions: unknown;
}): InboxViewActor {
  return {
    workspaceId: session.workspaceId,
    userId: session.userId,
    // `session.role` is the EFFECTIVE per-workspace role the guard already
    // computed (superAdmin / org owner|admin collapse to "admin").
    canManageShared: resolvePermissions(session.role, session.rolePermissions)[
      "inboxViews:manageShared"
    ],
  };
}

/**
 * The workspace's LIVE ids for every dimension a filter document can name.
 *
 * Loaded once for a SET of documents so resolving every view in the sidebar
 * costs five id-only lookups, not five per view.
 */
interface LiveViewRefs {
  stageIds: Set<string>;
  tagIds: Set<string>;
  userIds: Set<string>;
  accountIds: Set<string>;
  /** `ContactFieldDefinition.key` → the ids of its live select options. */
  fieldOptionIds: Map<string, Set<string>>;
}

@Injectable()
export class InboxViewsService {
  constructor(
    private readonly db: DbService,
    private readonly bus: EventBus,
  ) {}

  /**
   * Realtime tick for SHARED-view changes — the same `team.catalog_changed`
   * frame every other workspace catalog publishes (snippets, tags, stages).
   * Personal views deliberately stay silent: only the owner's tab cares, and
   * it refreshes after its own edit. Without this, a view an admin shared
   * appeared for teammates only on their next navigation (audit 2026-08-10).
   */
  private async publishSharedTick(workspaceId: string): Promise<void> {
    await this.bus.publish({ type: "team.catalog_changed", workspaceId, scope: "inbox-views" });
  }

  /** Columns the wire shape needs. Keeps the payload lean and explicit. */
  private static readonly SELECT = {
    id: true,
    workspaceId: true,
    name: true,
    color: true,
    icon: true,
    visibility: true,
    createdById: true,
    filters: true,
    position: true,
    createdAt: true,
    updatedAt: true,
    createdBy: { select: { name: true } },
  } satisfies Prisma.InboxViewSelect;

  /**
   * Views this session can see: every shared view in the workspace, plus the
   * caller's own personal ones.
   *
   * Carries BOTH documents: `filters` is what the author saved (what the
   * builder edits) and `resolvedFilters` is that document with dangling ids
   * dropped (what anything EVALUATING the view must read). The client's live
   * row-matcher used the stored one, so a socket event spliced rows out of a
   * view naming a deleted stage / teammate / option while a refetch — which
   * runs through `resolveFilters` — kept them. One batched resolution for the
   * whole visible set, so this stays five id-only lookups per request.
   */
  async list(actor: InboxViewActor): Promise<InboxView[]> {
    const rows = await this.db.inboxView.findMany({
      where: this.visibleWhere(actor),
      // Shared first — they are the team's agreed slices and belong at the top
      // of the rail; a personal view is a private overlay under them.
      orderBy: [{ visibility: "desc" }, { position: "asc" }, { name: "asc" }],
      select: InboxViewsService.SELECT,
    });
    const canManageShared = actor.canManageShared;
    const maskName = await actorNameMasker(
      this.db,
      [actor.workspaceId],
      rows.map((r) => r.createdById),
    );
    const views = rows.map((r) => this.toWire(r, actor.userId, canManageShared, maskName));
    const resolved = await this.resolveFiltersMany(
      actor.workspaceId,
      views.map((v) => v.filters),
    );
    return views.map((v, i) => ({ ...v, resolvedFilters: resolved[i]! }));
  }

  /**
   * One view, membership-checked. Used by the conversation list to resolve
   * `?viewId=` into a filter document.
   *
   * Returns the STORED filters. Dangling-id cleanup happens in
   * `resolveFilters` because it costs five extra queries, so callers opt in.
   *
   * (This used to say the list path was "the only caller that needs it". Not
   * true: `GET /inbox-views/counts` resolves too, deliberately — a badge that
   * skipped resolution would count a dangling tag as matching nothing while the
   * list it labels widens, so the number and the rows would disagree.
   * lib/inbox-views/where.ts is the one authority.)
   */
  async get(actor: InboxViewActor, id: string): Promise<InboxView> {
    const row = await this.db.inboxView.findFirst({
      // The id alone is not enough: an id from another workspace, or another
      // agent's personal view, must 404 — not 403, which would confirm it
      // exists.
      where: { id, ...this.visibleWhere(actor) },
      select: InboxViewsService.SELECT,
    });
    if (!row) throw new NotFoundException({ error: "inbox_view_not_found" });
    return this.toWire(row, actor.userId, actor.canManageShared, await this.maskFor(actor, row.createdById));
  }

  async create(actor: InboxViewActor, input: CreateInboxViewInput): Promise<InboxView> {
    const visibility = (input.visibility ?? "personal") as InboxViewVisibility;
    this.assertMayWrite(actor, visibility);

    // Cap per (workspace, visibility-scope). Counted inside the same statement
    // sequence as the insert rather than transactionally locked: the cap is a
    // clutter guard, not a billing limit, and two simultaneous creates landing
    // 31 views is harmless. The name uniqueness that DOES matter is enforced by
    // the partial indexes in the DB.
    await this.assertUnderCap(actor, visibility);

    const filters = input.filters as InboxViewFilters;
    this.normalizeFilters(filters);

    // Append to the end of its group.
    const last = await this.db.inboxView.findFirst({
      where: this.scopeWhere(actor, visibility),
      orderBy: { position: "desc" },
      select: { position: true },
    });

    try {
      const row = await this.db.inboxView.create({
        data: {
          workspaceId: actor.workspaceId,
          name: input.name,
          color: input.color ?? "slate",
          icon: input.icon ?? DEFAULT_INBOX_VIEW_ICON,
          visibility,
          createdById: actor.userId,
          filters: filters as Prisma.InputJsonValue,
          position: (last?.position ?? -1) + 1,
        },
        select: InboxViewsService.SELECT,
      });
      if (visibility === "shared") await this.publishSharedTick(actor.workspaceId);
      return this.toWire(row, actor.userId, actor.canManageShared, await this.maskFor(actor, row.createdById));
    } catch (err) {
      throw this.mapDuplicateName(err, visibility);
    }
  }

  async update(
    actor: InboxViewActor,
    id: string,
    input: UpdateInboxViewInput,
  ): Promise<InboxView> {
    const existing = await this.loadForWrite(actor, id);

    // Promoting personal → shared needs the shared capability; demoting
    // shared → personal needs it too (it removes the view from everyone
    // else's sidebar, which is a team-visible change).
    const nextVisibility = (input.visibility ?? existing.visibility) as InboxViewVisibility;
    if (nextVisibility !== existing.visibility) {
      this.assertMayWrite(actor, "shared");
      await this.assertUnderCap(actor, nextVisibility);
    }

    if (input.filters) this.normalizeFilters(input.filters as InboxViewFilters);

    // Demoting SHARED → personal has to re-own the view to whoever did it.
    // Left alone it keeps its original `createdById`, which may be someone
    // else — or `null`, if that author has since been deleted — and a personal
    // view with an owner who isn't you is invisible to everyone including the
    // person who just made it. "Take this private" has to mean private TO ME.
    const reown = nextVisibility === "personal" && existing.visibility === "shared";

    try {
      const row = await this.db.inboxView.update({
        where: { id: existing.id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.color !== undefined ? { color: input.color } : {}),
          ...(input.icon !== undefined ? { icon: input.icon } : {}),
          ...(input.visibility !== undefined
            ? { visibility: nextVisibility }
            : {}),
          ...(reown && actor.userId ? { createdById: actor.userId } : {}),
          ...(input.filters !== undefined
            ? { filters: input.filters as Prisma.InputJsonValue }
            : {}),
        },
        select: InboxViewsService.SELECT,
      });
      // Either side shared = teammates' lists changed (rename/refilter of a
      // shared view, promote personal→shared, or demote shared→personal).
      if (existing.visibility === "shared" || nextVisibility === "shared") {
        await this.publishSharedTick(actor.workspaceId);
      }
      return this.toWire(row, actor.userId, actor.canManageShared, await this.maskFor(actor, row.createdById));
    } catch (err) {
      throw this.mapDuplicateName(err, nextVisibility);
    }
  }

  async remove(actor: InboxViewActor, id: string): Promise<void> {
    const existing = await this.loadForWrite(actor, id);
    await this.db.inboxView.delete({ where: { id: existing.id } });
    if (existing.visibility === "shared") await this.publishSharedTick(actor.workspaceId);
  }

  /**
   * Manual reorder within one visibility group.
   *
   * Ids the caller may not write are dropped rather than rejected: a stale tab
   * can easily send a list containing a view an admin just un-shared, and
   * failing the whole drag over one stale id is worse UX than reordering the
   * rest. What it can never do is move a view it doesn't own.
   */
  async reorder(actor: InboxViewActor, input: ReorderInboxViewsInput): Promise<InboxView[]> {
    const rows = await this.db.inboxView.findMany({
      where: { id: { in: input.ids }, ...this.visibleWhere(actor) },
      select: { id: true, visibility: true, createdById: true },
    });
    const canManageShared = actor.canManageShared;
    const writable = rows.filter((r) =>
      r.visibility === "shared" ? canManageShared : r.createdById === actor.userId,
    );
    const byId = new Map(writable.map((r) => [r.id, r]));

    // Position is assigned from the caller's array index, filtered to the ids
    // we actually accepted — so the surviving order is exactly the order the
    // user dragged, with no gaps that would make a later insert tie.
    const ordered = input.ids.filter((id) => byId.has(id));
    if (ordered.length) {
      await this.db.$transaction(
        ordered.map((id, index) =>
          this.db.inboxView.update({ where: { id }, data: { position: index } }),
        ),
      );
    }
    // A reorder that touched a shared view changes teammates' sidebar order.
    if (rows.some((r) => r.visibility === "shared")) {
      await this.publishSharedTick(actor.workspaceId);
    }
    return this.list(actor);
  }

  /**
   * Resolve a view's stored filters into a document safe to turn into SQL,
   * dropping references to tags / stages / users / accounts / select-field
   * options that no longer exist.
   *
   * Why drop rather than match-nothing: deleting one tag of five would
   * otherwise empty the view completely, which reads as "the inbox is broken"
   * and gives no clue why. Dropping widens the view — visible, and
   * recoverable by editing it. Policy stated once in
   * `INBOX_VIEW_DANGLING_POLICY`.
   *
   * Five cheap id-only lookups, and only for the fields actually present —
   * a view with no tag/stage/user/account filter costs nothing.
   */
  async resolveFilters(
    workspaceId: string,
    filters: InboxViewFilters,
  ): Promise<InboxViewFilters> {
    const [resolved] = await this.resolveFiltersMany(workspaceId, [filters]);
    return resolved!;
  }

  /**
   * `resolveFilters` for a SET of documents — one lookup per dimension over the
   * union of their ids, instead of five queries per view. The sidebar resolves
   * up to sixty views on every list/counts call, so the batch is what keeps
   * that a fixed cost.
   */
  async resolveFiltersMany(
    workspaceId: string,
    documents: InboxViewFilters[],
  ): Promise<InboxViewFilters[]> {
    const stageIds = new Set<string>();
    const tagIds = new Set<string>();
    const userIds = new Set<string>();
    const accountIds = new Set<string>();
    const fieldKeys = new Set<string>();
    for (const f of documents) {
      for (const id of f.stageIds ?? []) stageIds.add(id);
      for (const id of f.tagIds ?? []) tagIds.add(id);
      if (f.assignee?.kind === "users") for (const id of f.assignee.userIds) userIds.add(id);
      for (const id of f.channelAccountIds ?? []) accountIds.add(id);
      for (const entry of f.fields ?? []) fieldKeys.add(entry.key);
    }
    if (
      !stageIds.size &&
      !tagIds.size &&
      !userIds.size &&
      !accountIds.size &&
      !fieldKeys.size
    ) {
      return documents;
    }

    const [stages, tags, users, accounts, fieldDefs] = await Promise.all([
      stageIds.size
        ? this.db.contactStage.findMany({
            where: { workspaceId, id: { in: [...stageIds] } },
            select: { id: true },
          })
        : Promise.resolve([]),
      tagIds.size
        ? this.db.tag.findMany({
            where: { workspaceId, id: { in: [...tagIds] } },
            select: { id: true },
          })
        : Promise.resolve([]),
      userIds.size
        ? this.db.workspaceMember.findMany({
            where: { workspaceId, userId: { in: [...userIds] } },
            select: { userId: true },
          })
        : Promise.resolve([]),
      // Deliberately NOT filtered on `isActive`: a deactivated account still
      // owns its threads and is still offered by the builder, so only a
      // DISCONNECTED (deleted) account is dangling.
      accountIds.size
        ? this.db.channelConnection.findMany({
            where: { workspaceId, id: { in: [...accountIds] } },
            select: { id: true },
          })
        : Promise.resolve([]),
      fieldKeys.size
        ? this.db.contactFieldDefinition.findMany({
            where: { workspaceId, key: { in: [...fieldKeys] }, type: "select" },
            select: { key: true, options: { select: { id: true } } },
          })
        : Promise.resolve([]),
    ]);

    const live: LiveViewRefs = {
      stageIds: new Set(stages.map((s) => s.id)),
      tagIds: new Set(tags.map((t) => t.id)),
      userIds: new Set(users.map((m) => m.userId)),
      accountIds: new Set(accounts.map((a) => a.id)),
      fieldOptionIds: new Map(
        fieldDefs.map((d) => [d.key, new Set(d.options.map((o) => o.id))]),
      ),
    };
    return documents.map((f) => this.applyLiveRefs(f, live));
  }

  /** Pure half of the resolution — the drop policy, applied to one document. */
  private applyLiveRefs(
    filters: InboxViewFilters,
    live: LiveViewRefs,
  ): InboxViewFilters {
    const resolved: InboxViewFilters = { ...filters };

    if (filters.stageIds?.length) {
      const kept = filters.stageIds.filter((id) => live.stageIds.has(id));
      if (kept.length) resolved.stageIds = kept;
      else delete resolved.stageIds;
    }
    if (filters.tagIds?.length) {
      const kept = filters.tagIds.filter((id) => live.tagIds.has(id));
      if (kept.length) resolved.tagIds = kept;
      else delete resolved.tagIds;
    }
    // Same drop policy as stages/tags: a number an admin disconnected would
    // otherwise leave an id matching no conversation, silently emptying the
    // view for the whole workspace.
    if (filters.channelAccountIds?.length) {
      const kept = filters.channelAccountIds.filter((id) => live.accountIds.has(id));
      if (kept.length) resolved.channelAccountIds = kept;
      else delete resolved.channelAccountIds;
    }
    const assignee = filters.assignee;
    if (assignee?.kind === "users" && assignee.userIds.length) {
      const kept = assignee.userIds.filter((id) => live.userIds.has(id));
      // An empty survivor list means every named teammate left the workspace.
      // Falling back to `anyone` (rather than dropping the field) keeps the
      // view's intent legible in the builder — it still says "assigned to",
      // just to nobody in particular.
      resolved.assignee = kept.length ? { kind: "users", userIds: kept } : { kind: "anyone" };
    }
    if (filters.fields?.length) {
      // Same drop policy: a deleted field or option widens the view visibly
      // instead of silently emptying it. Entry-level: dead key drops the whole
      // entry; dead option ids drop from the entry; an emptied entry drops.
      const kept = filters.fields
        .map((f) => {
          const liveOptions = live.fieldOptionIds.get(f.key);
          if (!liveOptions) return null;
          const optionIds = f.optionIds.filter((id) => liveOptions.has(id));
          return optionIds.length ? { key: f.key, optionIds } : null;
        })
        .filter((f): f is { key: string; optionIds: string[] } => f !== null);
      if (kept.length) resolved.fields = kept;
      else delete resolved.fields;
    }

    return resolved;
  }

  // ---- internals ---------------------------------------------------------

  /**
   * `shared OR (personal AND mine)`, workspace-scoped.
   *
   * A null-user actor (an API key) sees SHARED ONLY. Passing its null straight
   * into `createdById` would match `createdById IS NULL` — i.e. every personal
   * view whose author was deleted — handing a partner integration a set of
   * private filters it has no business reading. The null case is excluded
   * explicitly rather than left to the parameter.
   */
  private visibleWhere(actor: InboxViewActor): Prisma.InboxViewWhereInput {
    if (actor.userId === null) {
      return { workspaceId: actor.workspaceId, visibility: "shared" };
    }
    return {
      workspaceId: actor.workspaceId,
      OR: [
        { visibility: "shared" },
        { visibility: "personal", createdById: actor.userId },
      ],
    };
  }

  /** The uniqueness/cap scope a view of this visibility lives in. */
  private scopeWhere(
    actor: InboxViewActor,
    visibility: InboxViewVisibility,
  ): Prisma.InboxViewWhereInput {
    if (visibility === "shared") {
      return { workspaceId: actor.workspaceId, visibility: "shared" };
    }
    // Unreachable for a null-user actor — `assertMayWrite` rejects a personal
    // write before we get here — but the id-only shape keeps the null out of
    // the query rather than relying on that.
    return {
      workspaceId: actor.workspaceId,
      visibility: "personal",
      createdById: actor.userId ?? "__no_user__",
    };
  }

  private assertMayWrite(actor: InboxViewActor, visibility: InboxViewVisibility): void {
    // Saving a PERSONAL view is never gated — it is an agent organising their
    // own work, like a bookmark. Only the team-visible kind needs a capability.
    if (visibility === "shared") {
      if (!actor.canManageShared) {
        throw new ForbiddenException({ error: "forbidden_capability" });
      }
      return;
    }
    // A personal view needs a person to belong to. An API key has none, so it
    // may only create SHARED views — otherwise it would mint a view nobody can
    // ever see or delete from the UI.
    if (actor.userId === null) {
      throw new BadRequestException({ error: "inbox_view_requires_user" });
    }
  }

  /** Load a view the caller is allowed to MUTATE, or throw. */
  private async loadForWrite(actor: InboxViewActor, id: string) {
    const row = await this.db.inboxView.findFirst({
      where: { id, ...this.visibleWhere(actor) },
      select: { id: true, visibility: true, createdById: true },
    });
    if (!row) throw new NotFoundException({ error: "inbox_view_not_found" });

    if (row.visibility === "shared") {
      if (!actor.canManageShared) {
        throw new ForbiddenException({ error: "forbidden_capability" });
      }
    } else if (actor.userId === null || row.createdById !== actor.userId) {
      // Unreachable through `visibleWhere` today, which already excludes other
      // people's personal views. Kept as a second, independent check so a
      // future widening of the read boundary can't silently become a write
      // boundary too.
      throw new ForbiddenException({ error: "forbidden" });
    }
    return row;
  }

  private async assertUnderCap(
    actor: InboxViewActor,
    visibility: InboxViewVisibility,
  ): Promise<void> {
    const count = await this.db.inboxView.count({
      where: this.scopeWhere(actor, visibility),
    });
    if (count >= MAX_INBOX_VIEWS_PER_SCOPE) {
      throw new BadRequestException({
        error: "inbox_view_limit_reached",
        limit: MAX_INBOX_VIEWS_PER_SCOPE,
      });
    }
  }

  /**
   * Strip explicitly-empty lists from the document, IN PLACE, before it is
   * stored.
   *
   * Zod's `.max(3)` allows `[]`, and the where builder correctly reads an empty
   * list as "no opinion" — but storing one leaves a document that READS like a
   * filter ("statuses: []") and BEHAVES like none. That mismatch is what makes
   * a view impossible to reason about when someone opens it six months later.
   * Normalising at the boundary means what's stored is what's meant.
   */
  private normalizeFilters(filters: InboxViewFilters): void {
    if (filters.statuses && filters.statuses.length === 0) delete filters.statuses;
    if (filters.channels && filters.channels.length === 0) delete filters.channels;
    if (filters.tagIds && filters.tagIds.length === 0) {
      delete filters.tagIds;
      delete filters.tagMatch;
    }
    if (filters.stageIds && filters.stageIds.length === 0) delete filters.stageIds;
    // Entry-level emptiness is schema-impossible (optionIds.min(1)); only the
    // outer list can arrive empty.
    if (filters.fields && filters.fields.length === 0) delete filters.fields;
  }

  private mapDuplicateName(err: unknown, visibility: InboxViewVisibility): unknown {
    // The partial unique indexes are raw SQL, so Prisma reports P2002 without a
    // model-level target it recognises. Translate it here into a message that
    // names the actual scope — "already used by a shared view" vs "you already
    // have one" — because those need different fixes.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return new BadRequestException({
        error: "inbox_view_name_taken",
        scope: visibility,
      });
    }
    return err;
  }

  /**
   * `maskName` is the OPERATOR MASK (CLAUDE.md §18), and it is REQUIRED rather
   * than optional: a shared view names its author on the rail for the whole
   * team, and an optional argument is one forgotten call site away from putting
   * the platform operator's real name there. Resolve it with `actorNameMasker`.
   */
  /** One-row convenience over `actorNameMasker` for the single-view paths. */
  private maskFor(actor: InboxViewActor, createdById: string | null) {
    return actorNameMasker(this.db, [actor.workspaceId], [createdById]);
  }

  private toWire(
    row: Prisma.InboxViewGetPayload<{ select: typeof InboxViewsService.SELECT }>,
    /** `null` for an API-key actor — it owns no personal views, so nothing
     *  can ever be "mine" to it. */
    viewerUserId: string | null,
    canManageShared: boolean,
    maskName: (id: string | null | undefined, name: string | null | undefined) => string | null,
  ): InboxView {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      name: row.name,
      color: row.color,
      icon: row.icon,
      visibility: row.visibility as InboxViewVisibility,
      createdById: row.createdById ?? "",
      createdByName: maskName(row.createdById, row.createdBy?.name),
      filters: (row.filters ?? {}) as InboxViewFilters,
      position: row.position,
      isEditable:
        row.visibility === "shared"
          ? canManageShared
          // `viewerUserId` null must never match a null `createdById` — that
          // would make an API key the "owner" of every orphaned personal view.
          : viewerUserId !== null && row.createdById === viewerUserId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

/** Re-exported so the counts service and tests share one predicate. */
export { inboxViewIsViewerScoped };
