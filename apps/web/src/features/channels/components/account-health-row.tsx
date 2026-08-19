"use client";

import { LocalTime } from "@/components/local-time";
import { cn } from "@ccp/shared/utils";
import type { ChannelAccountHealth } from "@/lib/api/queries";

/**
 * What Meta currently allows ONE WhatsApp number to do.
 *
 * Deliberately per-number, because that is how Meta scopes it: quality and
 * throughput belong to the number, and two numbers in one workspace can sit at
 * GREEN and RED at the same time. The 24h budget and the template limit are the
 * exception — they belong to the parent PORTFOLIO and are shared — so they are
 * NOT rendered here. They are stated once, above the group, by
 * `PortfolioSummary`; repeating "10,000 / 24h" under each number would read as
 * two separate budgets and invite an operator to plan twice the volume they have.
 */
export function AccountHealthRow({
  health,
  nameStatus = null,
}: {
  health: ChannelAccountHealth;
  /** The display name's review status (raw Meta vocabulary). Only the
   *  problem states render — an APPROVED name is the silent normal. */
  nameStatus?: string | null;
}) {
  const quality = health.qualityRating;
  const throughput = health.throughputLevel;
  // The number is ALSO in use in the WhatsApp Business app — a hard 20 msg/s
  // ceiling Meta applies outside the throughput ladder it still reports.
  const coexistence = health.isOnBusinessApp === true;
  // Non-CONNECTED = every send from this number fails. The pill renders for
  // exactly that case; a CONNECTED number is the silent normal, like an
  // APPROVED display name.
  const registration = health.registrationStatus;
  const notRegistered = Boolean(registration && registration !== "CONNECTED");
  const ns = nameStatus?.toUpperCase() ?? null;
  const nameProblem = ns === "DECLINED" || ns === "EXPIRED" || ns === "NONE";
  const namePending = ns === "PENDING_REVIEW";

  // Nothing captured yet — say so plainly rather than rendering an empty row
  // that reads as "all clear".
  if (
    !quality &&
    !throughput &&
    !coexistence &&
    !health.updatedAt &&
    !nameProblem &&
    !namePending &&
    !notRegistered
  ) {
    return (
      <p className="mt-1 text-3xs text-muted-foreground">
        No health snapshot yet — Meta pushes these as they change, or press Refresh.
      </p>
    );
  }

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-3xs">
      {notRegistered && (
        <span className="inline-flex items-center gap-1">
          <span className="text-muted-foreground">Registration</span>
          <span
            className={cn(
              "rounded-full border px-1.5 py-px font-medium",
              registration === "PENDING"
                ? "border-warning-border bg-warning-bg text-warning-fg"
                : "border-destructive/30 bg-destructive/10 text-destructive",
            )}
            title="Sends from this number will fail until it is registered for Cloud API — use 'Register number' (two-step PIN), or register it in WhatsApp Manager → Phone numbers."
          >
            {registration === "PENDING" ? "PENDING" : `NOT REGISTERED · ${registration}`}
          </span>
        </span>
      )}

      {quality && (
        <span className="inline-flex items-center gap-1">
          <span className="text-muted-foreground">Quality</span>
          <span
            className={cn(
              "rounded-full border px-1.5 py-px font-medium",
              quality === "GREEN" && "border-success-border bg-success-bg text-success-fg",
              quality === "YELLOW" && "border-warning-border bg-warning-bg text-warning-fg",
              quality === "RED" && "border-destructive/30 bg-destructive/10 text-destructive",
            )}
          >
            {quality}
          </span>
        </span>
      )}

      {(throughput || coexistence) && (
        <span className="inline-flex items-center gap-1">
          <span className="text-muted-foreground">Throughput</span>
          <span className="font-medium text-foreground/80">
            {/* Coexistence WINS over the level, exactly as the send pacer does
                (`resolveSendRate`): Meta still reports STANDARD/HIGH for a
                number that is also in use in the WhatsApp Business app, while
                hard-capping it at 20 msg/s outside that ladder. */}
            {coexistence
              ? "Coexistence · capped at 20 msg/s by Meta"
              : throughput === "HIGH"
                ? "High · up to ~1,000 msg/s"
                : throughput === "STANDARD"
                  ? "Standard · up to ~80 msg/s"
                  : throughput}
          </span>
        </span>
      )}

      {(nameProblem || namePending) && (
        <span className="inline-flex items-center gap-1">
          <span className="text-muted-foreground">Display name</span>
          <span
            className={cn(
              "rounded-full border px-1.5 py-px font-medium",
              namePending && "border-warning-border bg-warning-bg text-warning-fg",
              nameProblem && "border-destructive/30 bg-destructive/10 text-destructive",
            )}
            title={
              nameProblem
                ? "Without an approved display name the number has no certificate and cannot be (re)registered for Cloud API. Fix it in WhatsApp Manager → Phone numbers."
                : "Meta is reviewing this number's display name."
            }
          >
            {ns}
          </span>
        </span>
      )}

      {health.updatedAt && (
        <span className="text-muted-foreground">
          Synced <LocalTime iso={health.updatedAt} format="listTime" />
        </span>
      )}

      {quality === "RED" && (
        <span className="w-full text-destructive">
          Quality is RED on this number — reduce volume and review recent templates.
        </span>
      )}
    </div>
  );
}
