/**
 * Meta reconciliation — compares what THIS SYSTEM stores/derives for a
 * workspace's Meta-backed accounts against what Meta's Graph says RIGHT NOW,
 * then (by default) heals drift through the same code paths production uses.
 * Born 2026-08-11: three incidents in one day were the same disease — the UI
 * asserting a claim about Meta state that nothing verified against Meta.
 *
 *   NODE_OPTIONS="--conditions=react-server" pnpm --filter @ccp/api exec tsx \
 *     scripts/meta-reconcile.ts <workspaceIdOrName> [--no-heal] [--no-sign] [--json]
 *
 * On the VPS (same script, prod rows):
 *   docker compose exec --workdir /app api node -r @swc-node/register \
 *     apps/api/scripts/meta-reconcile.ts <workspaceIdOrName>
 *
 * Heals ONLY through existing paths — `ensureWabaSubscribed`,
 * `fetchWhatsappHealthFromGraph` (which also re-links the portfolio), and
 * `syncTemplateCatalog`. Everything else prints MANUAL with the remedy.
 * Signing defaults ON (`META_APPSECRET_PROOF=1` is set before any app module
 * loads, so `withAppsecretProof` is live even where the local .env leaves it
 * unset for the e2e mock's sake) — a customer app with "Require app secret"
 * ON rejects unsigned reads, which is half of what today's incidents were.
 */
import { resolve } from "node:path";

import { config as loadEnv } from "dotenv";

loadEnv({ path: resolve(__dirname, "../../../.env") });

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const target = argv.find((a) => !a.startsWith("--"));
if (!target) {
  console.error("usage: meta-reconcile.ts <workspaceIdOrName> [--no-heal] [--no-sign] [--json]");
  process.exit(2);
}
const HEAL = !flags.has("--no-heal");
const JSON_OUT = flags.has("--json");
// BEFORE any app require: appsecret-proof.ts reads the flag at module load.
if (!flags.has("--no-sign")) process.env.META_APPSECRET_PROOF = "1";

const { setSharedDb } = require("../src/lib/db") as typeof import("../src/lib/db");
const { PrismaPg } = require("@prisma/adapter-pg") as typeof import("@prisma/adapter-pg");
const { PrismaClient } = require("@prisma/client") as typeof import("@prisma/client");

setSharedDb(
  new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  }) as never,
);

const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
const { getMetaSendConfig } =
  require("../src/lib/providers/config") as typeof import("../src/lib/providers/config");
const { GRAPH_BASE, graphGetJson } =
  require("../src/lib/providers/meta-graph") as typeof import("../src/lib/providers/meta-graph");
const { ensureWabaSubscribed, isAppSubscribedToWaba, listWabaPhoneNumberIds } =
  require("../src/lib/providers/meta-waba-subscription") as typeof import("../src/lib/providers/meta-waba-subscription");
const { fetchWhatsappHealthFromGraph, normalizeMessagingTier, tierDailyCap } =
  require("../src/lib/providers/meta-health") as typeof import("../src/lib/providers/meta-health");
const { syncTemplateCatalog } =
  require("../src/lib/templates/catalog-sync") as typeof import("../src/lib/templates/catalog-sync");
const { getMetaProvider } = require("../src/lib/providers") as typeof import("../src/lib/providers");
const { getPageSubscription } =
  require("../src/lib/providers/meta-page-subscription") as typeof import("../src/lib/providers/meta-page-subscription");
const { getMessengerSendConfig } =
  require("../src/lib/providers/messenger-config") as typeof import("../src/lib/providers/messenger-config");
const { getInstagramSendConfig } =
  require("../src/lib/providers/instagram-config") as typeof import("../src/lib/providers/instagram-config");
const { compareField, compareTemplates, infoRow, manualRow, summarize } =
  require("../src/lib/providers/meta-reconcile") as typeof import("../src/lib/providers/meta-reconcile");
type ReconcileRow = import("../src/lib/providers/meta-reconcile").ReconcileRow;

/** Meta's explicit "no data" sentinels read as absence, matching the persist path. */
function sentinel(v: unknown): unknown {
  const s = typeof v === "string" ? v.toUpperCase() : v;
  return s === "UNKNOWN" || s === "NOT_APPLICABLE" ? null : v;
}

async function main() {
  const ws =
    (await db.workspace.findUnique({ where: { id: target! } })) ??
    (await db.workspace.findFirst({ where: { name: target! } }));
  if (!ws) throw new Error(`workspace not found by id or name: ${target}`);
  console.error(`# reconciling workspace ${ws.name} (${ws.id}) heal=${HEAL}\n`);

  const rows: ReconcileRow[] = [];
  const version = process.env.META_GRAPH_VERSION ?? "v26.0";

  const conns = await db.channelConnection.findMany({
    where: { workspaceId: ws.id, channel: "whatsapp", isActive: true },
    select: {
      id: true,
      externalAccountId: true,
      verifiedName: true,
      nameStatus: true,
      qualityRating: true,
      throughputLevel: true,
      isOnBusinessApp: true,
      config: true,
      wabaAccount: {
        select: {
          id: true,
          externalWabaId: true,
          subscribedAt: true,
          portfolio: {
            select: {
              externalPortfolioId: true,
              messagingTier: true,
              messagingDailyCap: true,
              verificationStatus: true,
            },
          },
        },
      },
    },
  });

  for (const conn of conns) {
    const cfg = (conn.config ?? {}) as {
      phoneNumberId?: string;
      displayPhoneNumber?: string;
      appId?: string;
      wabaId?: string;
    };
    const phoneId = cfg.phoneNumberId ?? conn.externalAccountId ?? "";
    const entity = `wa ${phoneId}`;
    let send;
    try {
      send = await getMetaSendConfig(ws.id, conn.id);
    } catch (err) {
      rows.push(
        manualRow({
          entity,
          field: "credentials",
          meta: null,
          note: `send config unresolvable: ${err instanceof Error ? err.message : err}`,
        }),
      );
      continue;
    }

    // ---- phone number node: identity + registration + health --------------
    const node = (await graphGetJson(
      `${GRAPH_BASE}/${version}/${encodeURIComponent(phoneId)}` +
        `?fields=display_phone_number,verified_name,name_status,code_verification_status,status,` +
        `quality_rating,throughput,is_on_biz_app,whatsapp_business_manager_messaging_limit`,
      send.accessToken,
      { retry: true },
      send.appSecret,
    )) as Record<string, unknown>;

    rows.push(
      compareField({ entity, field: "displayPhoneNumber", system: cfg.displayPhoneNumber, meta: node.display_phone_number, note: "written at connect — re-save the number to refresh" }),
      compareField({ entity, field: "verifiedName", system: conn.verifiedName, meta: node.verified_name, note: "written at connect — re-save the number to refresh" }),
      compareField({ entity, field: "nameStatus", system: conn.nameStatus, meta: node.name_status, note: "written at connect + name webhooks — no sweeper re-polls (known gap)" }),
      // UNKNOWN / NOT_APPLICABLE are Meta's explicit no-data sentinels — the
      // persist path deliberately skips them, so treat them as absent here.
      compareField({ entity, field: "qualityRating", system: conn.qualityRating, meta: sentinel(node.quality_rating), heal: "fetchWhatsappHealthFromGraph" }),
      compareField({
        entity,
        field: "throughputLevel",
        system: conn.throughputLevel,
        meta: sentinel((node.throughput as { level?: unknown } | undefined)?.level),
        heal: "fetchWhatsappHealthFromGraph",
      }),
      compareField({
        entity,
        field: "isOnBusinessApp",
        system: conn.isOnBusinessApp == null ? null : String(conn.isOnBusinessApp),
        meta: node.is_on_biz_app == null ? null : String(node.is_on_biz_app === true),
        heal: "fetchWhatsappHealthFromGraph",
      }),
      manualRow({
        entity,
        field: "cloudApiStatus",
        meta: node.status,
        note:
          node.status === "CONNECTED"
            ? "registered — ok"
            : "NOT registered on Cloud API — no traffic until OTP-verified + registered (deliberately not stored; deferred gap)",
      }),
      manualRow({
        entity,
        field: "codeVerificationStatus",
        meta: node.code_verification_status,
        note:
          node.status === "CONNECTED"
            ? "ok — already registered (test numbers legitimately read NOT_VERIFIED)"
            : String(node.code_verification_status).toUpperCase() === "VERIFIED"
              ? "ownership verified — ok"
              : "verify ownership (OTP) in WhatsApp Manager BEFORE registering",
      }),
    );

    // Legacy trap: config.wabaId is declared in the type but no longer written;
    // a stale value disagreeing with the FK is a confusion bomb for debuggers.
    if (cfg.wabaId && cfg.wabaId !== conn.wabaAccount?.externalWabaId) {
      rows.push(
        manualRow({
          entity,
          field: "config.wabaId (legacy)",
          meta: conn.wabaAccount?.externalWabaId ?? null,
          note: `stale legacy config.wabaId=${cfg.wabaId} disagrees with the WABA FK — re-save the number to clear it`,
        }),
      );
    }

    // ---- WABA: ownership + webhook subscription ---------------------------
    const wabaId = conn.wabaAccount?.externalWabaId;
    if (!wabaId) {
      rows.push(manualRow({ entity, field: "waba", meta: null, note: "no WABA linked — reconnect the number (wabaId is required now)" }));
      continue;
    }
    const wabaEntity = `waba ${wabaId}`;

    const owned = await listWabaPhoneNumberIds(wabaId, send.accessToken, version, send.appSecret);
    rows.push(
      compareField({
        entity: wabaEntity,
        field: `owns phone ${phoneId}`,
        system: "true",
        meta: owned.ok ? String(owned.ids.includes(phoneId)) : null,
        note: owned.ok ? undefined : `phone_numbers unreadable: ${owned.error}`,
      }),
    );

    const subs = (await graphGetJson(
      `${GRAPH_BASE}/${version}/${encodeURIComponent(wabaId)}/subscribed_apps`,
      send.accessToken,
      { retry: true },
      send.appSecret,
    )) as Record<string, unknown>;
    const subscribed = isAppSubscribedToWaba(subs, cfg.appId ?? null);
    let subRow = compareField({
      entity: wabaEntity,
      field: `subscribed_apps has app ${cfg.appId ?? "(any)"}`,
      system: conn.wabaAccount?.subscribedAt ? "subscribed" : null,
      meta: subscribed ? "subscribed" : "NOT-SUBSCRIBED",
      heal: "ensureWabaSubscribed",
      note: subscribed
        ? conn.wabaAccount?.subscribedAt
          ? undefined
          : "subscribed at Meta; subscribedAt never stamped locally (connect stamps it — cosmetic)"
        : "zero inbound until subscribed — today's incident class",
    });
    if (!subscribed && HEAL) {
      const healed = await ensureWabaSubscribed(wabaId, send.accessToken, version, cfg.appId, send.appSecret);
      subRow = { ...subRow, note: healed.ok ? "HEALED: re-subscribed now" : `heal FAILED: ${healed.error}` };
    }
    rows.push(subRow);

    // ---- portfolio --------------------------------------------------------
    const ownerInfo = (await graphGetJson(
      `${GRAPH_BASE}/${version}/${encodeURIComponent(wabaId)}?fields=owner_business_info`,
      send.accessToken,
      { retry: true },
      send.appSecret,
    )) as { owner_business_info?: { id?: string } };
    const metaPortfolioId = ownerInfo.owner_business_info?.id ?? null;
    rows.push(
      compareField({
        entity: wabaEntity,
        field: "portfolio id",
        system: conn.wabaAccount?.portfolio?.externalPortfolioId,
        meta: metaPortfolioId,
        heal: "fetchWhatsappHealthFromGraph",
        note: metaPortfolioId === null ? "owner_business_info unreadable (business_management scope?)" : undefined,
      }),
    );
    if (metaPortfolioId) {
      const pf = (await graphGetJson(
        `${GRAPH_BASE}/${version}/${encodeURIComponent(metaPortfolioId)}` +
          `?fields=whatsapp_business_manager_messaging_limit,verification_status`,
        send.accessToken,
        { retry: true },
        send.appSecret,
      ).catch(() => null)) as Record<string, unknown> | null;
      if (pf) {
        const metaTier = normalizeMessagingTier(pf.whatsapp_business_manager_messaging_limit);
        rows.push(
          compareField({
            entity: `portfolio ${metaPortfolioId}`,
            field: "messagingTier",
            system: conn.wabaAccount?.portfolio?.messagingTier,
            meta: metaTier,
            heal: "fetchWhatsappHealthFromGraph",
            note: metaTier === null ? `raw=${String(pf.whatsapp_business_manager_messaging_limit)} (no tier assigned)` : undefined,
          }),
          compareField({
            entity: `portfolio ${metaPortfolioId}`,
            field: "messagingDailyCap",
            system: conn.wabaAccount?.portfolio?.messagingDailyCap,
            meta: metaTier ? tierDailyCap(metaTier) : null,
            heal: "fetchWhatsappHealthFromGraph",
            note: "derived from tier — no direct Graph field",
          }),
          compareField({
            entity: `portfolio ${metaPortfolioId}`,
            field: "verificationStatus",
            system: conn.wabaAccount?.portfolio?.verificationStatus,
            meta: pf.verification_status,
            heal: "fetchWhatsappHealthFromGraph",
          }),
        );
      }
    }

    // ---- heal pass for phone/portfolio drift ------------------------------
    const drifted = rows.some(
      (r) => (r.verdict === "drift" || r.verdict === "stale") && r.heal === "fetchWhatsappHealthFromGraph",
    );
    if (drifted && HEAL) {
      await fetchWhatsappHealthFromGraph(ws.id, conn.id);
      console.error(`  healed: fetchWhatsappHealthFromGraph(${phoneId}) ran — re-run to confirm convergence`);
    }

    // ---- template catalog -------------------------------------------------
    const provider = getMetaProvider();
    if (provider.fetchTemplates && send.wabaId) {
      try {
        const fetched = await provider.fetchTemplates(send);
        const stored = await db.messageTemplate.findMany({
          where: { workspaceId: ws.id, wabaAccountId: conn.wabaAccount!.id },
          select: { name: true, language: true, status: true, category: true, qualityScore: true, parameterFormat: true },
        });
        const tRows = compareTemplates(
          wabaEntity,
          stored.map((t) => ({ ...t })),
          fetched.map((t) => ({
            name: t.name,
            language: t.language,
            status: t.status ?? null,
            category: t.category ?? null,
            qualityScore: t.qualityScore ?? null,
            parameterFormat: t.parameterFormat ?? null,
          })),
        );
        rows.push(...tRows);
        if (HEAL && tRows.some((r) => r.verdict !== "match")) {
          await syncTemplateCatalog(ws.id);
          console.error(`  healed: syncTemplateCatalog(${wabaId}) ran — re-run to confirm convergence`);
        }
      } catch (err) {
        rows.push(
          manualRow({ entity: wabaEntity, field: "templates", meta: null, note: `fetch failed: ${err instanceof Error ? err.message : err}` }),
        );
      }
    }

    // ---- read-through surfaces (no stored mirror — reported, not diffed) --
    if (provider.getBusinessProfile) {
      const profile = await provider.getBusinessProfile(send).catch(() => null);
      rows.push(
        infoRow({
          entity,
          field: "businessProfile",
          meta: profile ? JSON.stringify(profile).slice(0, 120) : null,
          note: "read-through — the settings page shows exactly this call's result",
        }),
      );
    }
  }

  // ---- social channels: page/IG subscription state ------------------------
  for (const channel of ["messenger", "instagram"] as const) {
    const socials = await db.channelConnection.findMany({
      where: { workspaceId: ws.id, channel, isActive: true },
      select: { id: true, externalAccountId: true, config: true },
    });
    for (const conn of socials) {
      const cfg = (conn.config ?? {}) as { pageId?: string; appId?: string };
      const pageId = cfg.pageId ?? conn.externalAccountId ?? "";
      const entity = `${channel} ${conn.externalAccountId}`;
      try {
        const sc =
          channel === "messenger"
            ? await getMessengerSendConfig(ws.id, conn.externalAccountId)
            : await getInstagramSendConfig(ws.id, conn.externalAccountId);
        const sub = await getPageSubscription(pageId, sc.accessToken, sc.graphVersion, cfg.appId ?? null, sc.appSecret);
        rows.push(
          compareField({
            entity,
            field: "page messaging subscription",
            system: "subscribed",
            meta: sub.subscribed ? "subscribed" : "NOT-SUBSCRIBED",
            note: sub.subscribed ? `fields: ${sub.fields.slice(0, 6).join(",")}…` : "sweeper self-heals within 30 min, or re-save the channel",
          }),
        );
      } catch (err) {
        rows.push(
          manualRow({ entity, field: "subscription", meta: null, note: `unreadable: ${err instanceof Error ? err.message : err}` }),
        );
      }
    }
  }

  // ---- output -------------------------------------------------------------
  if (JSON_OUT) {
    console.log(JSON.stringify({ workspace: ws.id, rows, summary: summarize(rows) }, null, 2));
  } else {
    const w = (s: string | null, n: number) => (s ?? "—").slice(0, n).padEnd(n);
    console.log(`${"ENTITY".padEnd(26)} ${"FIELD".padEnd(38)} ${"SYSTEM".padEnd(22)} ${"META".padEnd(22)} VERDICT`);
    for (const r of rows) {
      const mark = r.verdict === "match" ? "  ok " : r.verdict === "info" ? " info" : `*${r.verdict.toUpperCase()}*`;
      console.log(`${w(r.entity, 26)} ${w(r.field, 38)} ${w(r.system, 22)} ${w(r.meta, 22)} ${mark}${r.note ? `  — ${r.note}` : ""}`);
    }
    const s = summarize(rows);
    console.log(
      `\nsummary: ${s.match} match · ${s.drift} drift · ${s.stale} stale · ${s.manual} manual · ${s.info} info` +
        (HEAL ? "  (heals ran where available — re-run to confirm convergence)" : ""),
    );
  }
  const s = summarize(rows);
  process.exit(s.drift + s.stale > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
