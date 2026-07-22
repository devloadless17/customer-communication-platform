import { randomBytes } from "node:crypto";

import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import {
  invalidateWebchatwidgetKey,
  invalidateWebchatwidgetTeam,
  type WebchatwidgetConfig,
  type WebchatwidgetPreChatField,
} from "@/lib/providers/webchatwidget-config";

import { EventBus } from "../../events/event-bus.module";
import { DbService } from "../../db/db.service";
import type { CreateWidgetInput, UpdateWidgetInput } from "./webchatwidget.schemas";

/** A widget as returned to the admin UI (never any secret — there are none). */
export interface WidgetView {
  id: string;
  name: string;
  publicKey: string;
  allowedOrigins: string[];
  config: WebchatwidgetConfig;
  isActive: boolean;
  /** Host of the first real site that embedded this widget; null until observed. */
  firstSeenOrigin: string | null;
  conversationCount: number;
  createdAt: string;
}

function mintPublicKey(): string {
  return `wc_pk_${randomBytes(24).toString("hex")}`;
}

function mintFieldId(): string {
  return `field_${randomBytes(8).toString("hex")}`;
}

/** Pull the appearance/pre-chat fields out of an input into the config JSON,
 *  minting ids for any new pre-chat fields. Only defined keys are written so a
 *  PATCH can leave others untouched (merged onto `base`). */
function buildConfig(
  input: Partial<CreateWidgetInput & UpdateWidgetInput>,
  base: WebchatwidgetConfig = {},
): WebchatwidgetConfig {
  const next: WebchatwidgetConfig = { ...base };
  if (input.theme !== undefined) next.theme = input.theme;
  if (input.welcomeMessage !== undefined) next.welcomeMessage = input.welcomeMessage;
  if (input.headerTitle !== undefined) next.headerTitle = input.headerTitle;
  if (input.headerSubtitle !== undefined) next.headerSubtitle = input.headerSubtitle;
  if (input.suggestedQuestions !== undefined) next.suggestedQuestions = input.suggestedQuestions;
  if (input.showBranding !== undefined) next.showBranding = input.showBranding;
  if (input.logoDataUrl !== undefined) next.logoDataUrl = input.logoDataUrl || undefined;
  if (input.agentAvatarDataUrl !== undefined) next.agentAvatarDataUrl = input.agentAvatarDataUrl || undefined;
  if (input.fontFamily !== undefined) next.fontFamily = input.fontFamily;
  if (input.themeMode !== undefined) next.themeMode = input.themeMode;
  if (input.soundEnabled !== undefined) next.soundEnabled = input.soundEnabled;
  if (input.allowedMediaKinds !== undefined) next.allowedMediaKinds = input.allowedMediaKinds;
  if (input.awayMessage !== undefined) next.awayMessage = input.awayMessage || undefined;
  if (input.aiEnabled !== undefined) next.aiEnabled = input.aiEnabled;
  if (input.showHeader !== undefined) next.showHeader = input.showHeader;
  if (input.launcher !== undefined) next.launcher = input.launcher;
  if (input.position !== undefined) next.position = input.position;
  if (input.launcherLabel !== undefined) next.launcherLabel = input.launcherLabel;
  if (input.preChatFields !== undefined) {
    next.preChatFields = input.preChatFields.map(
      (f): WebchatwidgetPreChatField => ({
        id: f.id ?? mintFieldId(),
        label: f.label,
        type: f.type,
        required: f.required,
      }),
    );
  }
  return next;
}

/**
 * Admin management of a team's website chat widgets — one row per website. No
 * external vendor, so no credential validation (unlike the Meta channels): a
 * widget is just a public site key + origin allow-list + appearance. Creating
 * the first widget makes the `webchatwidget` channel "connected" for the team
 * (getWebchatwidgetSendConfig gates on ≥1 active widget).
 */
@Injectable()
export class WebchatwidgetAdminService {
  constructor(
    private readonly db: DbService,
    private readonly bus: EventBus,
  ) {}

  async list(workspaceId: string): Promise<WidgetView[]> {
    const rows = await this.db.webchatWidget.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "asc" },
      include: { _count: { select: { conversations: true } } },
    });
    return rows.map((r) => this.toView(r, r._count.conversations));
  }

  async create(workspaceId: string, input: CreateWidgetInput): Promise<WidgetView> {
    const widget = await this.db.webchatWidget.create({
      data: {
        workspaceId,
        name: input.name,
        publicKey: mintPublicKey(),
        allowedOrigins: input.allowedOrigins,
        config: buildConfig(input) as Prisma.InputJsonValue,
        isActive: true,
      },
    });
    invalidateWebchatwidgetTeam(workspaceId);
    await this.announce(workspaceId);
    return this.toView(widget, 0);
  }

  async update(workspaceId: string, id: string, input: UpdateWidgetInput): Promise<WidgetView> {
    const existing = await this.db.webchatWidget.findFirst({
      where: { id, workspaceId },
      include: { _count: { select: { conversations: true } } },
    });
    if (!existing) throw new NotFoundException({ error: "widget_not_found" });

    const config = buildConfig(input, (existing.config ?? {}) as WebchatwidgetConfig);
    const updated = await this.db.webchatWidget.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.allowedOrigins !== undefined ? { allowedOrigins: input.allowedOrigins } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        config: config as Prisma.InputJsonValue,
      },
    });
    // Both caches key on stale state: the team's connected flag and the by-key
    // resolved config the visitor gateway reads.
    invalidateWebchatwidgetTeam(workspaceId);
    invalidateWebchatwidgetKey(existing.publicKey);
    await this.announce(workspaceId);
    return this.toView(updated, existing._count.conversations);
  }

  async remove(workspaceId: string, id: string): Promise<void> {
    const existing = await this.db.webchatWidget.findFirst({
      where: { id, workspaceId },
      select: { publicKey: true },
    });
    if (!existing) throw new NotFoundException({ error: "widget_not_found" });
    // Conversations SetNull their webchatWidgetId (history is preserved).
    await this.db.webchatWidget.delete({ where: { id } });
    invalidateWebchatwidgetTeam(workspaceId);
    invalidateWebchatwidgetKey(existing.publicKey);
    await this.announce(workspaceId);
  }

  private toView(
    r: {
      id: string;
      name: string;
      publicKey: string;
      allowedOrigins: string[];
      config: Prisma.JsonValue;
      isActive: boolean;
      createdAt: Date;
      firstSeenOrigin: string | null;
    },
    conversationCount: number,
  ): WidgetView {
    return {
      id: r.id,
      name: r.name,
      publicKey: r.publicKey,
      allowedOrigins: r.allowedOrigins,
      config: (r.config ?? {}) as WebchatwidgetConfig,
      isActive: r.isActive,
      // Drives the "lock this widget to <domain>?" suggestion in Settings. Only
      // meaningful while allowedOrigins is empty; the UI hides it once locked.
      firstSeenOrigin: r.firstSeenOrigin,
      conversationCount,
      createdAt: r.createdAt.toISOString(),
    };
  }

  /** Bust the channels catalog so Settings reflects connect/disconnect. */
  private async announce(workspaceId: string): Promise<void> {
    await this.bus.publish({ type: "team.catalog_changed", workspaceId, scope: "channels" });
  }
}
