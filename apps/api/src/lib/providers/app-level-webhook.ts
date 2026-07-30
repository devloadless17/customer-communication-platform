/**
 * The APP-LEVEL Meta webhook callback: which workspace does this payload belong to?
 *
 * ## Why this exists
 *
 * Today every workspace brings its own Meta app, and its webhooks arrive on
 * `POST /webhooks/meta/:workspaceId` — the path names the tenant. Under Embedded
 * Signup that stops being true: all onboarded customers' webhooks are delivered to
 * the **app's** callback URL, and Meta's docs are explicit that the override
 * mechanism cannot cover it. Per-WABA / per-phone-number `override_callback_uri`
 * applies ONLY to `messages`, `message_echoes`, `calls`, `consumer_profile`,
 * `messaging_handovers`, the group topics, `smb_message_echoes`,
 * `smb_app_state_sync`, `history` and `account_settings_update`. Template webhooks
 * (`message_template_status_update`, `_quality_update`, `_components_update`,
 * `template_category_update`) and account webhooks (`account_update`,
 * `account_review_update`, `account_alerts`) are **always** sent to the app's
 * default callback URL. There is no configuration that routes those per tenant.
 *
 * So a route with no workspaceId in the path is a requirement, not a nicety, and
 * the tenant has to come from the (already HMAC-verified) payload.
 *
 * ## Order is load-bearing
 *
 * VERIFY the signature first, resolve the workspace second. The per-workspace
 * route's own docstring notes that `workspaceId` in the path is a routing signal
 * and not proof of origin; here there is no path at all, so resolving first would
 * let an unauthenticated body drive DB lookups — an enumeration oracle and a DoS
 * lever. The caller enforces this; this module only ever sees trusted payloads.
 *
 * ## Never guess
 *
 * Every attribution path is an exact indexed lookup, and an ambiguous ENTRY is
 * dropped with a warn. `WhatsappBusinessAccount.externalWabaId` is globally unique
 * precisely so a WABA id resolves to at most one workspace — that index is the
 * tenancy guard.
 *
 * ## Per ENTRY, not per body
 *
 * Attribution is `groupEntriesByWorkspace`, which partitions a batch into one
 * group per workspace. It replaced a per-BODY resolver that collapsed the whole
 * POST to a single answer: because Meta batches "changes from different objects
 * that are of the same type", one body can carry two customers' WABAs, and that
 * resolver called such a body ambiguous and dropped every entry in it — including
 * the ones it could attribute cleanly. A drop answers 200, so they were gone for
 * good. Same bug class as the per-event phone-number attribution already fixed in
 * `inbound-accounts.ts`, one level up at the tenant.
 */

import { db } from "@/lib/db";
import type { Channel } from "@ccp/shared/types";

/** Outcome of attributing ONE entry. Internal to the grouping below. */
type AppLevelResolution =
  | { kind: "ok"; workspaceId: string; via: "waba_info" | "waba_id" | "portfolio_id" | "account_id" }
  | { kind: "none" }
  | { kind: "ambiguous"; detail: string };

/** Platform app secrets, comma-separated to allow a rotation window. */
export function platformAppSecrets(): string[] {
  const raw = process.env.META_APP_SECRET ?? "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function platformVerifyToken(): string | null {
  const raw = process.env.META_APP_VERIFY_TOKEN?.trim();
  return raw && raw.length > 0 ? raw : null;
}

/** True when the app-level callback is configured at all. */
export function appLevelWebhookEnabled(): boolean {
  return Boolean(process.env.META_APP_ID) && platformAppSecrets().length > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-ENTRY grouping
// ─────────────────────────────────────────────────────────────────────────────

/** One workspace's slice of an app-level batch. */
export interface WorkspaceEntryGroup {
  workspaceId: string;
  /** An envelope carrying ONLY this workspace's entries, safe to ingest as-is. */
  payload: unknown;
  entryCount: number;
}

/** Entries that could not be attributed, kept so the caller can log per entry. */
export interface UnattributedEntry {
  entryId: string | null;
  reason: "none" | "ambiguous";
  detail?: string;
}

export interface AppLevelGrouping {
  groups: WorkspaceEntryGroup[];
  unattributed: UnattributedEntry[];
}

/**
 * Collect this ONE entry's candidate ids, most specific first.
 *
 * `value.waba_info.waba_id` is the most specific hint and the one that covers
 * `account_update` / `PARTNER_ADDED` — the webhook Meta fires when a customer
 * completes Embedded Signup.
 *
 * On `entry[].id`: the current `account_update` reference documents it as the
 * WhatsApp Business Account id, and both 2026 example payloads show a WABA id
 * there; the portfolio appears only at `value.waba_info.owner_business_id`. An
 * older note in this file claimed the opposite. `resolveEntry` below therefore
 * tries waba_info → `entry[].id` as a WABA → `entry[].id` as a portfolio, so both
 * readings are tolerated and nothing depends on which is right. Do NOT narrow it to
 * one: several `account_update` events carry no `waba_info` block at all, and
 * attribution for exactly those would land nowhere.
 */
function entryCandidateIds(entry: unknown): { wabaInfo: string[]; entryId: string | null } {
  const e = entry as {
    id?: string;
    changes?: Array<{ value?: { waba_info?: { waba_id?: string } } }>;
  };
  const wabaInfo: string[] = [];
  for (const change of Array.isArray(e?.changes) ? e.changes : []) {
    const id = change?.value?.waba_info?.waba_id;
    if (typeof id === "string" && id.length > 0 && !wabaInfo.includes(id)) wabaInfo.push(id);
  }
  const entryId = typeof e?.id === "string" && e.id.length > 0 ? e.id : null;
  return { wabaInfo, entryId };
}

function addTo(map: Map<string, Set<string>>, key: string, workspaceId: string): void {
  const set = map.get(key);
  if (set) set.add(workspaceId);
  else map.set(key, new Set([workspaceId]));
}

/**
 * Partition an app-level batch into one group PER WORKSPACE.
 *
 * ## Why this exists, and why `resolveAppLevelWorkspace` was not enough
 *
 * Meta batches webhooks: "POST requests are aggregated and sent in a batch with a
 * maximum of 1000 updates. However, batching cannot be guaranteed so be sure to
 * adjust your servers to handle each POST request individually." And the platform
 * webhook reference is explicit that a batch spans OBJECTS, not just events:
 * "Multiple changes from different objects that are of the same type may be
 * batched together." For `object: "whatsapp_business_account"` those objects are
 * different WABAs — i.e. under a Tech Provider app serving many customers, ONE
 * POST can legitimately carry two tenants' entries.
 *
 * `resolveAppLevelWorkspace` collapses the WHOLE body to a single answer, so that
 * body resolved `ambiguous` and the controller dropped **every** entry in it,
 * including the ones it could attribute perfectly well. Meta retries a non-200,
 * but we answer 200 on a drop (deliberately — see the route), so those webhooks
 * were gone for good. This is the same per-body-vs-per-event bug class already
 * fixed one level down for phone numbers in `inbound-accounts.ts`, recurring at
 * the tenant level.
 *
 * ## Contract (mirrors `groupEventsByInboundAccount`)
 *
 *  - **Strict partition.** Every entry lands in exactly one group or in
 *    `unattributed`; none is duplicated, so ingesting each group in turn processes
 *    each entry exactly once.
 *  - **Never guess.** An entry whose ids map to more than one workspace is
 *    `ambiguous` and dropped — attributing it to one of two candidates is a
 *    cross-tenant leak, strictly worse than a visible drop. Only that ENTRY is
 *    dropped now, not its batch-mates.
 *  - **Order preserved** within each group.
 *  - **Bounded queries.** Three `findMany`s over the union of candidate ids,
 *    regardless of how many entries the batch holds — a 1000-update POST does not
 *    become 1000 round trips.
 */
export async function groupEntriesByWorkspace(
  channel: Channel,
  payload: unknown,
): Promise<AppLevelGrouping> {
  const p = payload as { object?: unknown; entry?: unknown[] };
  const entries = Array.isArray(p?.entry) ? p.entry : [];
  if (entries.length === 0) return { groups: [], unattributed: [] };

  const perEntry = entries.map((e) => entryCandidateIds(e));
  const allIds = [
    ...new Set(perEntry.flatMap((c) => [...c.wabaInfo, ...(c.entryId ? [c.entryId] : [])])),
  ];
  if (allIds.length === 0) {
    return {
      groups: [],
      unattributed: entries.map(() => ({ entryId: null, reason: "none" as const })),
    };
  }

  // One lookup per id-space. `externalWabaId` is GLOBALLY unique so its sets are
  // singletons by construction; a portfolio id is unique only per workspace and a
  // social `externalAccountId` is not globally unique at all, so those genuinely
  // can resolve to several workspaces — which is exactly what `ambiguous` is for.
  const byWaba = new Map<string, Set<string>>();
  const byPortfolio = new Map<string, Set<string>>();
  const byAccount = new Map<string, Set<string>>();

  if (channel === "whatsapp") {
    const [wabas, portfolios] = await Promise.all([
      db.whatsappBusinessAccount.findMany({
        where: { externalWabaId: { in: allIds } },
        select: { externalWabaId: true, workspaceId: true },
      }),
      db.whatsappPortfolio.findMany({
        where: { externalPortfolioId: { in: allIds } },
        select: { externalPortfolioId: true, workspaceId: true },
      }),
    ]);
    for (const w of wabas) {
      if (w.externalWabaId) addTo(byWaba, w.externalWabaId, w.workspaceId);
    }
    for (const f of portfolios) {
      // `externalPortfolioId` is nullable — a portfolio row can exist before its
      // Meta id is known. A null can never match an inbound id, so skip it rather
      // than keying the map on "".
      if (f.externalPortfolioId) addTo(byPortfolio, f.externalPortfolioId, f.workspaceId);
    }
  } else {
    const conns = await db.channelConnection.findMany({
      where: { channel, externalAccountId: { in: allIds } },
      select: { externalAccountId: true, workspaceId: true },
    });
    for (const c of conns) addTo(byAccount, c.externalAccountId, c.workspaceId);
  }

  /** Resolve ONE entry using the prefetched maps, in the documented order. */
  function resolveEntry(cand: { wabaInfo: string[]; entryId: string | null }): AppLevelResolution {
    const attempts: Array<{ ids: string[]; map: Map<string, Set<string>>; what: string }> =
      channel === "whatsapp"
        ? [
            { ids: cand.wabaInfo, map: byWaba, what: "waba_info.waba_id" },
            { ids: cand.entryId ? [cand.entryId] : [], map: byWaba, what: "entry[].id as WABA id" },
            {
              ids: cand.entryId ? [cand.entryId] : [],
              map: byPortfolio,
              what: "entry[].id as portfolio id",
            },
          ]
        : [
            {
              ids: cand.entryId ? [cand.entryId] : [],
              map: byAccount,
              what: `entry[].id as ${channel} account id`,
            },
          ];

    for (const attempt of attempts) {
      const hits = new Set<string>();
      for (const id of attempt.ids) for (const ws of attempt.map.get(id) ?? []) hits.add(ws);
      if (hits.size === 1) {
        return { kind: "ok", workspaceId: [...hits][0]!, via: "waba_id" };
      }
      if (hits.size > 1) {
        return {
          kind: "ambiguous",
          detail: `${attempt.what} maps to ${hits.size} workspaces`,
        };
      }
    }
    return { kind: "none" };
  }

  const byWorkspace = new Map<string, unknown[]>();
  const unattributed: UnattributedEntry[] = [];

  for (let i = 0; i < entries.length; i++) {
    const cand = perEntry[i]!;
    const res = resolveEntry(cand);
    if (res.kind !== "ok") {
      unattributed.push({
        entryId: cand.entryId,
        reason: res.kind,
        ...(res.kind === "ambiguous" ? { detail: res.detail } : {}),
      });
      continue;
    }
    const bucket = byWorkspace.get(res.workspaceId);
    if (bucket) bucket.push(entries[i]);
    else byWorkspace.set(res.workspaceId, [entries[i]]);
  }

  return {
    groups: [...byWorkspace].map(([workspaceId, own]) => ({
      workspaceId,
      // Rebuild a real envelope so each group is ingestable by the SAME code path
      // that handles a single-tenant body — the parsers read `object` off it.
      payload: { ...(payload as Record<string, unknown>), entry: own },
      entryCount: own.length,
    })),
    unattributed,
  };
}
