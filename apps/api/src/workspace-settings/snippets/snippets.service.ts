import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import { EventBus } from "../../events/event-bus.module";
import { DbService } from "../../db/db.service";
import { actorNameMasker } from "@/lib/workspaces/operator-mask";
import type {
  CreateSnippetInput,
  UpdateSnippetInput,
} from "./snippets.schemas";

/** See create(). `list()` is deliberately unpaginated; this is its bound. */
const MAX_SNIPPETS_PER_WORKSPACE = 300;

export interface SnippetDto {
  id: string;
  name: string;
  label: string;
  body: string;
  createdById: string | null;
  createdByName: string;
  updatedAt: string;
}

@Injectable()
export class SnippetsService {
  constructor(
    private readonly db: DbService,
    private readonly bus: EventBus,
  ) {}

  async list(workspaceId: string): Promise<SnippetDto[]> {
    // No pagination — small N, the picker needs the full set on first open.
    const rows = await this.db.snippet.findMany({
      where: { workspaceId },
      orderBy: [{ label: "asc" }],
      include: { createdBy: { select: { id: true, name: true } } },
    });
    // OPERATOR MASK (CLAUDE.md §18) — an operator writing a snippet during
    // onboarding must not sign it with their real name.
    const maskName = await actorNameMasker(this.db, [workspaceId], rows.map((r) => r.createdById));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      label: r.label,
      body: r.body,
      createdById: r.createdById,
      createdByName: maskName(r.createdById, r.createdBy?.name) ?? "Removed user",
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  async create(
    workspaceId: string,
    /** Null when an API key created it — an integration is not a person. */
    userId: string | null,
    input: CreateSnippetInput,
  ): Promise<{ id: string }> {
    // Same reasoning as the tag cap: an unpaginated list that every client in
    // the workspace refetches on `team.catalog_changed` needs a bound, and
    // snippet BODIES are far larger than tag names.
    const count = await this.db.snippet.count({ where: { workspaceId } });
    if (count >= MAX_SNIPPETS_PER_WORKSPACE) {
      throw new BadRequestException({
        error: "snippet_limit_reached",
        detail: `This workspace has reached its limit of ${MAX_SNIPPETS_PER_WORKSPACE} snippets. Delete an unused one to make room.`,
      });
    }
    try {
      const created = await this.db.snippet.create({
        data: { workspaceId, createdById: userId, ...input },
      });
      await this.bus.publish({ type: "team.catalog_changed", workspaceId, scope: "snippets" });
      return { id: created.id };
    } catch (err) {
      throwIfUniqueViolation(err, `A snippet named "${input.name}" already exists.`);
      throw err;
    }
  }

  async update(
    workspaceId: string,
    id: string,
    input: UpdateSnippetInput,
  ): Promise<void> {
    try {
      const result = await this.db.snippet.updateMany({
        where: { id, workspaceId },
        data: input,
      });
      if (result.count === 0) {
        throw new NotFoundException({ error: "snippet_not_found" });
      }
      await this.bus.publish({ type: "team.catalog_changed", workspaceId, scope: "snippets" });
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      throwIfUniqueViolation(err, "Another snippet already uses that name.");
      throw err;
    }
  }

  async remove(workspaceId: string, id: string): Promise<void> {
    const result = await this.db.snippet.deleteMany({ where: { id, workspaceId } });
    if (result.count === 0) {
      throw new NotFoundException({ error: "snippet_not_found" });
    }
    await this.bus.publish({ type: "team.catalog_changed", workspaceId, scope: "snippets" });
  }
}

function throwIfUniqueViolation(err: unknown, detail: string): void {
  if (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "P2002"
  ) {
    throw new ConflictException({ error: "name_already_in_use", detail });
  }
}
