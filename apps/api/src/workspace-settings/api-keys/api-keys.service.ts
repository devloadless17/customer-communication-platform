import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";

import { generateApiKey } from "@/auth/api-key";

import { DbService } from "../../db/db.service";
import { EventBus } from "../../events/event-bus.module";
import type { CreateApiKeyInput } from "./api-keys.schemas";

export interface ApiKeyListDto {
  id: string;
  name: string;
  tokenPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  scopes: string[];
}

export interface ApiKeyCreateDto {
  id: string;
  name: string;
  tokenPrefix: string;
  createdAt: string;
  scopes: string[];
  /** Plaintext token — returned ONCE on create. Never persisted, never returned again. */
  token: string;
}

@Injectable()
export class ApiKeysService {
  constructor(
    private readonly db: DbService,
    private readonly bus: EventBus,
  ) {}

  async list(workspaceId: string): Promise<ApiKeyListDto[]> {
    const keys = await this.db.workspaceApiKey.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        tokenPrefix: true,
        createdAt: true,
        lastUsedAt: true,
        revokedAt: true,
        scopes: true,
      },
    });
    return keys.map((k) => ({
      id: k.id,
      name: k.name,
      tokenPrefix: k.tokenPrefix,
      createdAt: k.createdAt.toISOString(),
      lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
      revokedAt: k.revokedAt?.toISOString() ?? null,
      scopes: k.scopes,
    }));
  }

  async create(
    workspaceId: string,
    userId: string,
    input: CreateApiKeyInput,
  ): Promise<ApiKeyCreateDto> {
    const generated = generateApiKey();
    // Scopes are REQUIRED by the schema now (they used to default to the
    // wildcard, so a bare `{"name":"x"}` minted a full-access key). The
    // fallback stays only as a type narrowing — Zod has already rejected an
    // empty/absent list before we get here.
    const scopes = input.scopes;
    const row = await this.db.workspaceApiKey.create({
      data: {
        workspaceId,
        name: input.name,
        tokenHash: generated.tokenHash,
        tokenPrefix: generated.tokenPrefix,
        createdById: userId,
        scopes,
      },
      select: { id: true, name: true, tokenPrefix: true, createdAt: true, scopes: true },
    });
    await this.bus.publish({ type: "team.catalog_changed", workspaceId, scope: "api-keys" });
    return {
      id: row.id,
      name: row.name,
      tokenPrefix: row.tokenPrefix,
      createdAt: row.createdAt.toISOString(),
      scopes: row.scopes,
      // The ONLY response that contains the plaintext. The client copies
      // it now or has to rotate.
      token: generated.token,
    };
  }

  /**
   * Soft-revoke. Hard delete would erase audit + lastUsedAt history and
   * look identical to a key that never existed. Once revoked, the bearer
   * guard rejects further requests.
   */
  async revoke(workspaceId: string, id: string): Promise<void> {
    const key = await this.db.workspaceApiKey.findFirst({
      where: { id, workspaceId },
      select: { id: true, revokedAt: true },
    });
    if (!key) throw new NotFoundException({ error: "key not found" });
    if (key.revokedAt) return; // Idempotent — revoking twice is fine.
    await this.db.workspaceApiKey.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
    await this.bus.publish({ type: "team.catalog_changed", workspaceId, scope: "api-keys" });
  }

  /**
   * Atomic rotate: revoke the existing key + create a new one carrying the
   * same name and scopes, returning the new plaintext. Lets an operator who
   * lost the original plaintext recover with one click instead of having to
   * (a) revoke, (b) re-pick scopes, (c) re-name, (d) re-paste into the
   * integration. The two writes run in a single $transaction so we never
   * leave a team with two active keys of the same name (the integration UI
   * uses name as the "already connected" signal).
   */
  async rotate(
    workspaceId: string,
    userId: string,
    id: string,
  ): Promise<ApiKeyCreateDto> {
    const existing = await this.db.workspaceApiKey.findFirst({
      where: { id, workspaceId },
      select: { id: true, name: true, scopes: true, revokedAt: true },
    });
    if (!existing) throw new NotFoundException({ error: "key not found" });
    // Rotating an ALREADY-REVOKED key re-granted exactly what was revoked: a
    // leaked key that an admin killed could be brought back (new secret, same
    // scopes, active again) by anyone who could reach this route. Rotation
    // means "replace a live credential", so a revoked key is terminal —
    // create a fresh key instead, deliberately.
    if (existing.revokedAt) {
      throw new BadRequestException({
        error: "key_revoked",
        detail:
          "This key was revoked and can't be rotated back into service. Create a new key instead.",
      });
    }
    const generated = generateApiKey();
    const created = await this.db.$transaction(async (tx) => {
      await tx.workspaceApiKey.update({
        where: { id: existing.id },
        data: { revokedAt: new Date() },
      });
      return tx.workspaceApiKey.create({
        data: {
          workspaceId,
          name: existing.name,
          tokenHash: generated.tokenHash,
          tokenPrefix: generated.tokenPrefix,
          createdById: userId,
          scopes: existing.scopes,
        },
        select: { id: true, name: true, tokenPrefix: true, createdAt: true, scopes: true },
      });
    });
    await this.bus.publish({ type: "team.catalog_changed", workspaceId, scope: "api-keys" });
    return {
      id: created.id,
      name: created.name,
      tokenPrefix: created.tokenPrefix,
      createdAt: created.createdAt.toISOString(),
      scopes: created.scopes,
      token: generated.token,
    };
  }
}
