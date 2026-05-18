import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import { EventBus } from "../../events/event-bus.module";
import { DbService } from "../../db/db.service";
import type {
  CreateSnippetInput,
  UpdateSnippetInput,
} from "./snippets.schemas";

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

  async list(teamId: string): Promise<SnippetDto[]> {
    // No pagination — small N, the picker needs the full set on first open.
    const rows = await this.db.snippet.findMany({
      where: { teamId },
      orderBy: [{ label: "asc" }],
      include: { createdBy: { select: { id: true, name: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      label: r.label,
      body: r.body,
      createdById: r.createdById,
      createdByName: r.createdBy?.name ?? "Removed user",
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  async create(
    teamId: string,
    userId: string,
    input: CreateSnippetInput,
  ): Promise<{ id: string }> {
    try {
      const created = await this.db.snippet.create({
        data: { teamId, createdById: userId, ...input },
      });
      await this.bus.publish({ type: "team.catalog_changed", teamId, scope: "snippets" });
      return { id: created.id };
    } catch (err) {
      throwIfUniqueViolation(err, `A snippet named "${input.name}" already exists.`);
      throw err;
    }
  }

  async update(
    teamId: string,
    id: string,
    input: UpdateSnippetInput,
  ): Promise<void> {
    try {
      const result = await this.db.snippet.updateMany({
        where: { id, teamId },
        data: input,
      });
      if (result.count === 0) {
        throw new NotFoundException({ error: "snippet not found" });
      }
      await this.bus.publish({ type: "team.catalog_changed", teamId, scope: "snippets" });
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      throwIfUniqueViolation(err, "Another snippet already uses that name.");
      throw err;
    }
  }

  async remove(teamId: string, id: string): Promise<void> {
    const result = await this.db.snippet.deleteMany({ where: { id, teamId } });
    if (result.count === 0) {
      throw new NotFoundException({ error: "snippet not found" });
    }
    await this.bus.publish({ type: "team.catalog_changed", teamId, scope: "snippets" });
  }
}

function throwIfUniqueViolation(err: unknown, detail: string): void {
  if (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "P2002"
  ) {
    throw new ConflictException({ error: "name already in use", detail });
  }
}
