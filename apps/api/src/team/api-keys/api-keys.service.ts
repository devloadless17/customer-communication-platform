import { Injectable, NotFoundException } from "@nestjs/common";

import { generateApiKey } from "@/auth/api-key";

import { PrismaService } from "../../prisma/prisma.service";
import type { CreateApiKeyInput } from "./api-keys.schemas";

export interface ApiKeyListDto {
  id: string;
  name: string;
  tokenPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface ApiKeyCreateDto {
  id: string;
  name: string;
  tokenPrefix: string;
  createdAt: string;
  /** Plaintext token — returned ONCE on create. Never persisted, never returned again. */
  token: string;
}

@Injectable()
export class ApiKeysService {
  constructor(private readonly prisma: PrismaService) {}

  async list(teamId: string): Promise<ApiKeyListDto[]> {
    const keys = await this.prisma.teamApiKey.findMany({
      where: { teamId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        tokenPrefix: true,
        createdAt: true,
        lastUsedAt: true,
        revokedAt: true,
      },
    });
    return keys.map((k) => ({
      id: k.id,
      name: k.name,
      tokenPrefix: k.tokenPrefix,
      createdAt: k.createdAt.toISOString(),
      lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
      revokedAt: k.revokedAt?.toISOString() ?? null,
    }));
  }

  async create(
    teamId: string,
    userId: string,
    input: CreateApiKeyInput,
  ): Promise<ApiKeyCreateDto> {
    const generated = generateApiKey();
    const row = await this.prisma.teamApiKey.create({
      data: {
        teamId,
        name: input.name,
        tokenHash: generated.tokenHash,
        tokenPrefix: generated.tokenPrefix,
        createdById: userId,
      },
      select: { id: true, name: true, tokenPrefix: true, createdAt: true },
    });
    return {
      id: row.id,
      name: row.name,
      tokenPrefix: row.tokenPrefix,
      createdAt: row.createdAt.toISOString(),
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
  async revoke(teamId: string, id: string): Promise<void> {
    const key = await this.prisma.teamApiKey.findFirst({
      where: { id, teamId },
      select: { id: true, revokedAt: true },
    });
    if (!key) throw new NotFoundException({ error: "key not found" });
    if (key.revokedAt) return; // Idempotent — revoking twice is fine.
    await this.prisma.teamApiKey.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
  }
}
