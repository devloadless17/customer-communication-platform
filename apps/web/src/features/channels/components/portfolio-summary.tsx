"use client";

import { Building2 } from "lucide-react";

import type { ChannelAccountHealth } from "@/lib/api/queries";

type Portfolio = NonNullable<ChannelAccountHealth["portfolio"]>;

/**
 * The header for a group of WhatsApp numbers that SHARE a business portfolio.
 *
 * This exists to prevent a specific, expensive misreading. Since 2025-10-07 Meta
 * scopes the 24h messaging limit to the portfolio, so two numbers under one
 * portfolio draw on ONE budget. Listing "10,000 / 24h" beside each number reads
 * as 20,000 and invites an operator to plan a campaign that Meta will refuse
 * halfway through. So the budget and the template limit are stated ONCE, here,
 * with the number of accounts sharing them said out loud.
 *
 * Numbers in different portfolios get separate groups, because their budgets
 * genuinely are independent.
 */
export function PortfolioSummary({
  portfolio,
  accountsInGroup,
}: {
  portfolio: Portfolio | null;
  /** How many of THIS workspace's accounts are in this group. */
  accountsInGroup: number;
}) {
  // No portfolio resolved: usually a token without `business_management`. Say
  // what is missing and what it costs, rather than showing a blank header.
  if (!portfolio || !portfolio.externalId) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-dashed px-3 py-2">
        <Building2 aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div className="text-2xs text-muted-foreground">
          <span className="font-medium text-foreground/80">Business portfolio not resolved</span>
          {" — "}
          the connected system-user token is missing the{" "}
          <span className="font-mono">business_management</span> permission. Meta marks it
          optional, but it is what lets us read your portfolio, so without it the shared
          24-hour sending budget and the template limit stay blank and large broadcasts go out
          ungated (Meta still enforces the real limit — you just lose the warning).
          <br />
          Fix: Business Settings → System Users → your token → <em>Generate new token</em>,
          tick <span className="font-mono">business_management</span> alongside the two
          WhatsApp permissions, then re-paste it below.
        </div>
      </div>
    );
  }

  const cap = portfolio.messagingDailyCap;
  const verified = portfolio.verificationStatus === "verified";

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border bg-muted/30 px-3 py-2 text-2xs">
      <span className="inline-flex items-center gap-1.5 font-medium">
        <Building2 aria-hidden className="size-3.5 text-muted-foreground" />
        Business portfolio
        <span className="font-mono font-normal text-muted-foreground">
          {portfolio.externalId}
        </span>
      </span>

      <span className="text-muted-foreground">
        24h budget{" "}
        <span className="font-medium text-foreground/80">
          {cap !== null
            ? `${cap.toLocaleString()} customers`
            : portfolio.messagingTier === "TIER_UNLIMITED"
              ? "Unlimited"
              : "Not assigned yet"}
        </span>
        {accountsInGroup > 1 && (
          <>
            {" "}
            — <strong>shared by {accountsInGroup} numbers</strong>
          </>
        )}
      </span>

      <span className="text-muted-foreground">
        Templates{" "}
        <span className="font-medium text-foreground/80">
          up to {portfolio.templateLimit.toLocaleString()}
        </span>{" "}
        per WhatsApp Business Account
        {!verified && (
          <> — verify this portfolio with Meta to raise it to 6,000</>
        )}
      </span>
    </div>
  );
}
