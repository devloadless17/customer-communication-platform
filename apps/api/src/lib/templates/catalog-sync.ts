// Note: no `server-only` import — loaded by the NestJS api process (controller,
// webhook ingest and a sweeper all call in) via @swc-node/register, outside the
// Next bundler context.

import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { getMetaProvider } from "@/lib/providers";
import {
  getMetaSendConfig,
  ProviderNotConfiguredError,
  type MetaSendConfig,
} from "@/lib/providers/config";
import type { ProviderTemplate } from "@ccp/shared/providers/types";

/**
 * WhatsApp template catalog reconciliation — the single implementation.
 *
 * Three callers need identical behaviour and used to have none: the "Sync"
 * button, the `message_template_components_update` webhook, and the periodic
 * backstop sweeper. It lives in the domain layer (not the NestJS service) so the
 * webhook ingest and the sweeper can call it without reaching through a
 * controller seam.
 *
 * THE INVARIANT THIS FILE EXISTS TO HOLD: a sync is authoritative only for the
 * WABA it fetched. Templates live on a WhatsApp Business Account, and one
 * workspace can now connect several numbers under DIFFERENT WABAs. The previous
 * implementation fetched the default account's WABA and then pruned every local
 * row the workspace had, matched on (name, language) with no WABA filter — so
 * one click on Sync deleted the entire catalog of every other WABA, taking the
 * `variableBindings` we own (and Meta cannot give back) with it.
 */

export interface CatalogSyncResult {
  /** Templates Meta returned, across every WABA we successfully reached. */
  syncedCount: number;
  /** Local rows removed because Meta no longer lists them. */
  prunedCount: number;
  /** WABAs we could not reach; their local rows were left untouched. */
  failed: Array<{ wabaId: string; error: string }>;
}

/**
 * Rows synced in the last minute are spared the prune.
 *
 * `createTemplate` writes the local row immediately, but Meta's list endpoint is
 * eventually consistent — a sync racing a create would otherwise "reconcile away"
 * the template the author just submitted.
 */
const CREATE_GRACE_MS = 60_000;

/**
 * Composite key for "is this template still in Meta's list". A template's
 * (name, language) pair is immutable at Meta, which is what makes it usable as
 * an identity across a refetch.
 *
 * Delimited with an ESCAPED NUL, never a raw byte: a raw NUL in source makes
 * grep/rg classify this file as binary and skip it.
 */
const key = (name: string, language: string) => `${name}\u0000${language}`;

/**
 * Pull every reachable WABA's catalog and reconcile it into `MessageTemplate`.
 *
 * Fail-soft per WABA: one account with a revoked token must not stop the others
 * from syncing, and — critically — must not let its own templates be pruned. A
 * WABA that threw is simply not reconciled this run.
 */
export async function syncTemplateCatalog(workspaceId: string): Promise<CatalogSyncResult> {
  const result: CatalogSyncResult = { syncedCount: 0, prunedCount: 0, failed: [] };

  const provider = getMetaProvider();
  if (!provider.fetchTemplates) return result;

  const connections = await db.channelConnection.findMany({
    where: { workspaceId, channel: "whatsapp", isActive: true },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    select: { id: true },
  });

  // Several numbers commonly sit under ONE WABA and share its catalog, so
  // fetching per-number would page the same list repeatedly and reconcile it
  // twice. Dedupe on the WABA the resolved credentials actually point at — not
  // on the denormalized column — so the id we fetch with and the id we key rows
  // by can never disagree.
  const done = new Set<string>();

  for (const conn of connections) {
    let config;
    try {
      config = await getMetaSendConfig(workspaceId, conn.id);
    } catch (err) {
      // Fail-soft per account, including on an unexpected error (a corrupt
      // secret, a decrypt failure). Rethrowing would abort the whole sweep and
      // leave every OTHER account of this workspace unreconciled because one of
      // them has bad credentials.
      if (!(err instanceof ProviderNotConfiguredError)) {
        result.failed.push({
          wabaId: "",
          error: err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }
    const wabaId = config.wabaId ?? "";
    if (!wabaId || done.has(wabaId)) continue;
    done.add(wabaId);

    let fetched: ProviderTemplate[];
    try {
      fetched = await provider.fetchTemplates(config);
    } catch (err) {
      result.failed.push({
        wabaId,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const one = await reconcileWaba(workspaceId, wabaId, fetched);
    result.syncedCount += one.syncedCount;
    result.prunedCount += one.prunedCount;

    // Backfill parameter TYPES for library rows that lack them. The WABA edge
    // returns the marker but NOT `body_param_types` — those live only on the
    // library-browse endpoint — so a library template we didn't create (or a
    // resync-recreated row) has the marker with no types, and the send-time
    // type checks would silently not run. One blueprint fetch per DISTINCT
    // missing library name (usually zero), fail-soft: a library hiccup must
    // not fail the sync that just completed.
    await backfillLibraryParamTypes(workspaceId, wabaId, config).catch(() => undefined);
  }

  return result;
}

/** See the call site above. Bounded: one library lookup per distinct name. */
async function backfillLibraryParamTypes(
  workspaceId: string,
  wabaId: string,
  config: MetaSendConfig,
): Promise<void> {
  const provider = getMetaProvider();
  if (!provider.fetchTemplateLibrary) return;
  const missing = await db.messageTemplate.findMany({
    where: {
      workspaceId,
      wabaId,
      libraryTemplateName: { not: null },
      bodyParamTypes: { isEmpty: true },
    },
    select: { id: true, libraryTemplateName: true },
  });
  if (missing.length === 0) return;
  const byName = new Map<string, string[]>();
  for (const row of missing) {
    const name = row.libraryTemplateName!;
    const ids = byName.get(name) ?? [];
    ids.push(row.id);
    byName.set(name, ids);
  }
  for (const [name, ids] of byName) {
    const blueprints = await provider.fetchTemplateLibrary({ name }, config);
    const types = blueprints[0]?.bodyParamTypes ?? [];
    if (types.length === 0) continue;
    await db.messageTemplate.updateMany({
      where: { workspaceId, id: { in: ids } },
      data: { bodyParamTypes: types },
    });
  }
}

/**
 * Reconcile ONE WABA's fetched catalog against the local rows for THAT WABA.
 *
 * `fetched` is complete-or-thrown (the provider pages fully or raises), so
 * anything local under this `wabaId` and absent from it really is gone at Meta.
 */
async function reconcileWaba(
  workspaceId: string,
  wabaId: string,
  fetched: ProviderTemplate[],
): Promise<{ syncedCount: number; prunedCount: number }> {
  const now = new Date();

  // Load the local rows ONCE, before the upsert, and reuse them for both the
  // archived-transition detection below and the prune at the end. Reading after
  // the upsert would see our own writes and make every template look unchanged.
  const localRows = await db.messageTemplate.findMany({
    where: { workspaceId, wabaId },
    select: {
      id: true,
      name: true,
      language: true,
      status: true,
      archivedAt: true,
      syncedAt: true,
    },
  });
  const localByKey = new Map(localRows.map((r) => [key(r.name, r.language), r]));

  await db.$transaction(
    fetched.map((t) => {
      const existing = localByKey.get(key(t.name, t.language));
      // Meta never states an archival DATE, so the countdown starts when we
      // OBSERVE the transition — and only on the transition, so a later sync
      // doesn't keep pushing the deadline forward and hide an expiring template.
      const archivedAt =
        t.status === "archived"
          ? existing?.status === "archived"
            ? (existing.archivedAt ?? now)
            : now
          : null;

      return db.messageTemplate.upsert({
        where: {
          workspaceId_wabaId_name_language: {
            workspaceId,
            wabaId,
            name: t.name,
            language: t.language,
          },
        },
        create: {
          workspaceId,
          wabaId,
          externalId: t.externalId ?? null,
          name: t.name,
          language: t.language,
          // A brand-new row needs concrete values. An unmappable status is
          // treated as non-sendable rather than optimistically "approved"; an
          // unmappable category falls back to the most EXPENSIVE one, so a cost
          // estimate errs high instead of under-quoting the operator.
          category: t.category ?? "marketing",
          correctCategory: t.correctCategory ?? null,
          status: t.status ?? "paused",
          archivedAt,
          bodyText: t.bodyText,
          components: t.components as unknown as Prisma.InputJsonValue,
          parameterFormat: t.parameterFormat,
          messageSendTtlSeconds: t.messageSendTtlSeconds ?? null,
          qualityScore: t.qualityScore ?? null,
          qualityScoreAt: t.qualityScoreAt ?? null,
          // The Template Library marker — send-time parameter TYPE checks key
          // on it. Without persisting it here, a library template created in
          // WhatsApp Manager (or a row recreated by resync) lost the checks.
          libraryTemplateName: t.libraryTemplateName ?? null,
          syncedAt: now,
        },
        update: {
          externalId: t.externalId ?? null,
          // An unmappable value leaves the stored one ALONE. Writing a guess
          // over a known-good category/status would be worse than being one
          // sync behind — see normalizeMetaTemplate for why these can be null.
          ...(t.category ? { category: t.category } : {}),
          ...(t.status ? { status: t.status } : {}),
          // Only touched when Meta actually reported a status: an unmappable
          // status must not clear a live archival deadline.
          ...(t.status ? { archivedAt } : {}),
          // `correctCategory` is different: null is meaningful ("no longer
          // impacted"), so it is always written.
          correctCategory: t.correctCategory ?? null,
          bodyText: t.bodyText,
          components: t.components as unknown as Prisma.InputJsonValue,
          parameterFormat: t.parameterFormat,
          messageSendTtlSeconds: t.messageSendTtlSeconds ?? null,
          // A band Meta didn't return leaves the stored one alone — the same
          // rule as status/category. The webhook is the fresher source here, so
          // a sync that asked for the field and got nothing must not wipe a band
          // the webhook just delivered.
          ...(t.qualityScore ? { qualityScore: t.qualityScore } : {}),
          ...(t.qualityScoreAt ? { qualityScoreAt: t.qualityScoreAt } : {}),
          // ADD-ONLY, never cleared: a template cannot stop being
          // library-created, and a Graph version that omits the field must not
          // strip the type-check identity off every stored row.
          ...(t.libraryTemplateName ? { libraryTemplateName: t.libraryTemplateName } : {}),
          syncedAt: now,
        },
      });
    }),
  );

  const fetchedKeys = new Set(fetched.map((t) => key(t.name, t.language)));
  const graceCutoff = new Date(now.getTime() - CREATE_GRACE_MS);
  const staleIds = localRows
    .filter((r) => !fetchedKeys.has(key(r.name, r.language)) && r.syncedAt < graceCutoff)
    .map((r) => r.id);
  if (staleIds.length > 0) {
    await db.messageTemplate.deleteMany({ where: { workspaceId, id: { in: staleIds } } });
  }

  return { syncedCount: fetched.length, prunedCount: staleIds.length };
}
