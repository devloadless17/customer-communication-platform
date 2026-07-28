"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { Gauge, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { cn } from "@ccp/shared/utils";
import { Button } from "@/components/ui/button";
import { LocalTime } from "@/components/local-time";
import { apiFetch } from "@/lib/api/client-fetch";

/**
 * WhatsApp messaging health — what Meta currently allows this number to do.
 *
 * These numbers already existed and already gated broadcasts; they were just
 * never SHOWN. The result was a customer whose 8,000-recipient campaign got
 * refused with no way to see why, or who had no idea their quality rating had
 * slipped to RED until sends started failing.
 *
 * Reads `GET /api/broadcasts/messaging-health` — the same endpoint the
 * broadcast composer uses for its pre-send warning, deliberately reused rather
 * than duplicated so the settings page and the composer can never disagree
 * about the remaining budget.
 */

interface Health {
  messagingTier: string | null;
  messagingDailyCap: number | null;
  qualityRating: string | null;
  hasSnapshot: boolean;
  recentUniqueRecipients: number | null;
  remainingDailyBudget: number | null;
  throughputLevel: string | null;
  externalPortfolioId: string | null;
  portfolioAccountCount: number;
  /** Meta's raw portfolio `verification_status` ("verified" | "not_verified" | …). */
  verificationStatus: string | null;
  /** Templates each WABA under the portfolio may hold — 250 unverified, up to
   *  6,000 verified. An upper bound, not a hard gate. */
  templateLimit: number;
  /** WhatsApp Business policy violation Meta reported — the warning that
   *  precedes an account restriction. */
  policyViolationType: string | null;
  policyViolationAt: string | null;
  /** ACTIVE utility-template enforcement (server filters expired): utility
   *  sends rate-limited, or utility templates restricted/recategorized. */
  utilityRestrictionType: string | null;
  utilityRestrictedUntil: string | null;
  /** ACTIVE policy/spam messaging enforcement (server filters expired; a set
   *  type with a null `until` is an indefinite lock/ban). Business-initiated
   *  blocks templates/broadcasts; customer-initiated blocks even replies. */
  bizMessagingRestrictionType: string | null;
  bizMessagingRestrictedUntil: string | null;
  customerMessagingRestrictionType: string | null;
  customerMessagingRestrictedUntil: string | null;
  messagingHealthUpdatedAt: string | null;
}

/** Meta publishes ~80 msg/s for STANDARD and up to ~1,000 for HIGH. */
const THROUGHPUT_LABEL: Record<string, string> = {
  STANDARD: "Standard · up to ~80 messages/second",
  HIGH: "High · up to ~1,000 messages/second",
};

/**
 * Human phrasing for the policy-violation codes Meta enumerates in its
 * "WhatsApp Business Platform Policy Violations" list. Meta says the list can
 * change, so an unknown code falls back to the raw value — never hidden.
 */
const POLICY_VIOLATION_LABEL: Record<string, string> = {
  ADULT: "adult products or services",
  ALCOHOL: "sale of alcohol",
  ANIMALS: "sale of animals or animal products",
  BODY_PARTS_FLUIDS: "sale of human body parts or fluids",
  DATING: "online dating services",
  DIGITAL_SERVICES_PRODUCTS: "sale of digital content, subscriptions, or accounts",
  DRUGS: "sale of illegal, prescription, or recreational drugs",
  GAMBLING: "gambling or games of skill for money",
  HEALTHCARE: "restricted healthcare products",
  ILLEGAL_PRODUCTS: "illegal products or services",
  MISLEADING: "misleading, deceptive, or exploitative offerings",
  OVERTLY_SEXUALIZED_POSITIONING: "sexually suggestive positioning of products",
  REAL_FAKE_CURRENCY: "sale of real, virtual, or fake currency",
  SCAM: "activity that promotes or facilitates scams",
  SUPPLEMENTS: "sale of unsafe ingestible supplements",
  THIRD_PARTY_INFRINGEMENTS: "counterfeit goods or intellectual-property infringement",
  TOBACCO: "sale of tobacco products or paraphernalia",
  UNAUTHORIZED_MEDIA: "devices enabling unauthorized media streaming",
  WEAPONS: "sale or use of weapons, ammunition, or explosives",
};

/** Copy per messaging-restriction shape. `WABA_BAN_*` types come from Meta's
 *  DISABLED_UPDATE ban states; the RESTRICTED_* types from ACCOUNT_RESTRICTION. */
function messagingRestrictionCopy(health: Health): {
  title: string;
  body: string;
  until: string | null;
} | null {
  const biz = health.bizMessagingRestrictionType;
  const customer = health.customerMessagingRestrictionType;
  if (!biz && !customer) return null;
  // Bans stamp both directions with the same WABA_BAN_* type.
  if (biz?.startsWith("WABA_BAN_") || customer?.startsWith("WABA_BAN_")) {
    const scheduled = (biz ?? customer) === "WABA_BAN_SCHEDULE_FOR_DISABLE";
    return {
      title: scheduled
        ? "Meta has scheduled this WhatsApp Business Account to be disabled"
        : "Meta has disabled this WhatsApp Business Account",
      body: scheduled
        ? "Messaging still works until the ban date, but the account will be disabled unless the decision is reversed. Appeal now in Meta Business Support Home."
        : "No messages can be sent from any number under this account until an appeal succeeds. Request a review in Meta Business Support Home.",
      until: null,
    };
  }
  const until = health.bizMessagingRestrictedUntil ?? health.customerMessagingRestrictedUntil;
  if (biz && customer) {
    return {
      title: "Meta has blocked ALL messaging on this WhatsApp Business Account",
      body: "Every send — broadcasts, templates, and replies to customers — is rejected by Meta for the duration of this restriction. This is Meta's escalation for repeated policy or spam violations.",
      until,
    };
  }
  if (biz) {
    return {
      title: "Meta has blocked business-initiated messages on this WhatsApp Business Account",
      body: "Template sends — broadcasts, campaigns, and proactive messages — are rejected by Meta for the duration of this restriction. Replies inside the 24-hour customer service window still work.",
      until: health.bizMessagingRestrictedUntil,
    };
  }
  return {
    title: "Meta has blocked replies to customer conversations on this WhatsApp Business Account",
    body: "Responses to customer-initiated conversations are rejected by Meta for the duration of this restriction.",
    until: health.customerMessagingRestrictedUntil,
  };
}

export function MessagingHealthPanel({
  canManage,
  accountCount = 1,
  accountId = null,
  accountName = null,
}: {
  canManage: boolean;
  /**
   * How many WhatsApp numbers this workspace has. With one number the default
   * figures are the whole truth; with several, the subtitle names WHICH
   * account the figures describe (the switcher above drives `accountId`).
   */
  accountCount?: number;
  /** The account these figures describe; null = the channel default. */
  accountId?: string | null;
  /** Its display name, for the subtitle. */
  accountName?: string | null;
}) {
  const [health, setHealth] = useState<Health | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, startTransition] = useTransition();

  const accountQuery = accountId
    ? `?accountId=${encodeURIComponent(accountId)}`
    : "";

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/broadcasts/messaging-health${accountQuery}`);
      if (!res.ok) return;
      setHealth((await res.json()) as Health);
    } catch {
      // Leave the last good value on screen. A transient blip must not blank a
      // panel whose whole job is to state the current limits.
    } finally {
      setLoading(false);
    }
  }, [accountQuery]);

  useEffect(() => {
    void load();
  }, [load]);

  function resync() {
    startTransition(async () => {
      const res = await apiFetch(
        `/api/workspace/whatsapp/health/refresh${accountQuery}`,
        { method: "POST" },
      );
      if (!res.ok) {
        toast.error(
          res.status === 429
            ? "Too many refreshes — try again in a minute."
            : "Couldn't reach Meta. The figures below are the last known good ones.",
        );
        return;
      }
      const body = (await res.json()) as { refreshed: boolean };
      // An honest outcome, not a blanket success toast: `refreshed:false` means
      // Meta didn't answer and what's on screen is still the OLD snapshot.
      if (body.refreshed) toast.success("Refreshed from Meta");
      else toast.warning("Meta didn't respond — showing the last known figures");
      await load();
    });
  }

  if (loading) {
    // Fixed height so the panel doesn't shift the page when it lands.
    return <div className="h-40 animate-pulse rounded-xl border border-border bg-muted/30" />;
  }
  if (!health) return null;

  const used = health.recentUniqueRecipients;
  const cap = health.messagingDailyCap;
  const pct = cap && used != null ? Math.min(100, Math.round((used / cap) * 100)) : null;

  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Gauge className="size-4 text-muted-foreground" />
            Messaging health
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {accountCount > 1 ? (
              <>
                What Meta allows{" "}
                <strong>{accountName ?? "your default number"}</strong> to send.
                Quality and throughput are per number — switch above for the
                others. The 24-hour budget below is shared across the whole
                business portfolio.
              </>
            ) : (
              <>
                What Meta currently allows this number to send. Updated automatically;
                refresh to pull it now.
              </>
            )}
          </p>
        </div>
        {canManage && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={resync}
            disabled={pending}
          >
            {pending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            Refresh
          </Button>
        )}
      </header>

      {/* An ACTIVE messaging restriction outranks everything on this panel —
          sends are being rejected right now. Shown even without a snapshot;
          it arrives by webhook. */}
      {(() => {
        const restriction = messagingRestrictionCopy(health);
        if (!restriction) return null;
        return (
          <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5">
            <p className="text-xs font-medium text-destructive">{restriction.title}</p>
            <p className="mt-1 text-2xs text-muted-foreground">
              {restriction.body}{" "}
              {restriction.until ? (
                <>
                  Lifts <LocalTime iso={restriction.until} format="localeString" />.{" "}
                  Some spam restrictions cannot be appealed — if this one can, the
                  option appears in Meta Business Support Home (Request Review).
                </>
              ) : (
                <>
                  No end date — it stands until Meta reverses it. Appeal in Meta
                  Business Support Home (Request Review); decisions typically take
                  24–48 hours.
                </>
              )}
            </p>
          </div>
        );
      })()}

      {/* A policy violation outranks every figure below it: Meta restricts an
          account that doesn't address one, and this is the only warning that
          comes first. Shown even without a snapshot — it arrives by webhook. */}
      {health.policyViolationType && (
        <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5">
          <p className="text-xs font-medium text-destructive">
            WhatsApp reported a policy violation:{" "}
            <span className="font-mono">{health.policyViolationType}</span>
            {POLICY_VIOLATION_LABEL[health.policyViolationType] && (
              <> — {POLICY_VIOLATION_LABEL[health.policyViolationType]}</>
            )}
          </p>
          <p className="mt-1 text-2xs text-muted-foreground">
            {health.policyViolationAt && (
              <>
                Reported <LocalTime iso={health.policyViolationAt} format="localeString" />.{" "}
              </>
            )}
            Violations start as warnings, then escalate to messaging blocks of
            increasing length (1&ndash;30 days, then an account lock). Review the
            WhatsApp Business Messaging Policy and your recent campaigns — the
            details, and the appeal (Request Review), are in Meta Business
            Support Home.
          </p>
        </div>
      )}

      {/* Utility-template enforcement: Meta's escalation for utility templates
          that read as marketing. Same rank as a policy violation — an active
          restriction rejects sends the operator believes are fine. */}
      {health.utilityRestrictionType && (
        <div className="mt-4 rounded-lg border border-warning-border bg-warning-bg px-3 py-2.5">
          <p className="text-xs font-medium text-warning-fg">
            {health.utilityRestrictionType === "RATE_LIMITED_UTILITY_TEMPLATE_MESSAGING"
              ? "Utility sends are rate-limited on this WhatsApp Business Account"
              : "Utility templates are restricted on this WhatsApp Business Account"}
          </p>
          <p className="mt-1 text-2xs text-muted-foreground">
            Meta applies this when utility templates read as marketing.{" "}
            {health.utilityRestrictionType === "RATE_LIMITED_UTILITY_TEMPLATE_MESSAGING"
              ? "Utility messages beyond Meta's rolling-24h cap are rejected; marketing and authentication sends are unaffected."
              : "Approved utility templates were recategorized to marketing (billed differently), and new utility template creation is blocked."}{" "}
            {health.utilityRestrictedUntil && (
              <>
                Lifts <LocalTime iso={health.utilityRestrictedUntil} format="localeString" />.{" "}
              </>
            )}
            You can appeal per-template in Meta&apos;s Business Support (Template
            Category Updates → Request Review).
          </p>
        </div>
      )}

      {!health.hasSnapshot ? (
        <p className="mt-4 rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
          No snapshot yet. Meta pushes these figures as they change, and we poll
          periodically — press Refresh to fetch them now. Until then, sends are
          not pre-checked against a limit (Meta still enforces the real one).
        </p>
      ) : (
        <>
          {/* The 24h budget is the number people actually act on, so it gets the
              bar and the top slot rather than being one row in a definition list. */}
          {cap != null && used != null ? (
            <div className="mt-4">
              <div className="flex items-baseline justify-between text-xs">
                <span className="font-medium">24-hour sending budget</span>
                <span className="tabular-nums text-muted-foreground">
                  {(health.remainingDailyBudget ?? 0).toLocaleString()} of{" "}
                  {cap.toLocaleString()} remaining
                </span>
              </div>
              <div
                className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-valuenow={pct ?? 0}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="24-hour sending budget used"
              >
                <div
                  className={cn(
                    "h-full rounded-full transition-[width] duration-500",
                    // Colour by headroom, not by a fixed palette: at 90% the
                    // next campaign is the one that gets refused.
                    (pct ?? 0) >= 90
                      ? "bg-destructive"
                      : (pct ?? 0) >= 70
                        ? "bg-warning-fg"
                        : "bg-success-fg",
                  )}
                  style={{ width: `${pct ?? 0}%` }}
                />
              </div>
              <p className="mt-1.5 text-2xs text-muted-foreground">
                {used.toLocaleString()} unique customer
                {used === 1 ? "" : "s"} messaged in the last 24 hours.
                {health.portfolioAccountCount > 1 && (
                  <>
                    {" "}
                    This budget is shared across{" "}
                    <strong>{health.portfolioAccountCount} numbers</strong> in the same
                    business portfolio.
                  </>
                )}
              </p>
            </div>
          ) : (
            <p className="mt-4 text-xs text-muted-foreground">
              No 24-hour cap — this portfolio is on an unlimited messaging tier.
            </p>
          )}

          <dl className="mt-4 grid grid-cols-[130px_1fr] gap-x-3 gap-y-2 border-t border-border pt-4 text-xs">
            <dt className="text-muted-foreground">Messaging tier</dt>
            <dd>{health.messagingTier ? tierLabel(health.messagingTier) : "Unknown"}</dd>

            <dt className="text-muted-foreground">Quality rating</dt>
            <dd>
              {health.qualityRating ? (
                <span
                  className={cn(
                    "rounded-full border px-1.5 py-0.5 text-2xs font-medium",
                    health.qualityRating === "GREEN" &&
                      "border-success-border bg-success-bg text-success-fg",
                    health.qualityRating === "YELLOW" &&
                      "border-warning-border bg-warning-bg text-warning-fg",
                    health.qualityRating === "RED" &&
                      "border-destructive/30 bg-destructive/10 text-destructive",
                  )}
                >
                  {health.qualityRating}
                </span>
              ) : (
                <span className="text-muted-foreground">Unknown</span>
              )}
              {health.qualityRating === "RED" && (
                <span className="ml-2 text-muted-foreground">
                  At risk of a tier downgrade — reduce volume and check your
                  templates.
                </span>
              )}
            </dd>

            <dt className="text-muted-foreground">Throughput</dt>
            <dd>
              {health.throughputLevel
                ? (THROUGHPUT_LABEL[health.throughputLevel] ?? health.throughputLevel)
                : "Unknown"}
            </dd>

            <dt className="text-muted-foreground">Business portfolio</dt>
            <dd className="min-w-0 break-all font-mono">
              {health.externalPortfolioId ?? (
                <span className="font-sans text-muted-foreground">
                  Not resolved — the connected token may lack{" "}
                  <span className="font-mono">business_management</span>.
                </span>
              )}
            </dd>

            <dt className="text-muted-foreground">Template limit</dt>
            <dd>
              {health.templateLimit.toLocaleString()} per WhatsApp Business Account
              {health.verificationStatus === "verified" ? (
                <span className="ml-2 text-muted-foreground">
                  Portfolio is verified — the 6,000 ceiling also needs one number with an
                  approved display name.
                </span>
              ) : (
                <span className="ml-2 text-muted-foreground">
                  {health.verificationStatus === null
                    ? "Verification status not read yet — showing the unverified limit."
                    : "Verify your business portfolio with Meta to raise this to 6,000."}
                </span>
              )}
            </dd>

            <dt className="text-muted-foreground">Last synced</dt>
            <dd className="text-muted-foreground">
              {health.messagingHealthUpdatedAt ? (
                <LocalTime iso={health.messagingHealthUpdatedAt} format="localeString" />
              ) : (
                "Never"
              )}
            </dd>
          </dl>
        </>
      )}
    </section>
  );
}

/** "TIER_10K" → "10,000 customers / 24h". Meta's own vocabulary is opaque. */
function tierLabel(tier: string): string {
  if (tier === "TIER_UNLIMITED") return "Unlimited";
  const m = /^TIER_(\d+)(K?)$/.exec(tier);
  if (!m) return tier;
  const n = Number(m[1]) * (m[2] === "K" ? 1_000 : 1);
  return `${n.toLocaleString()} customers / 24h`;
}
