import { AlertOctagon, TriangleAlert } from "lucide-react";

import { cn } from "@ccp/shared/utils";

/**
 * PAGE INTEGRITY — Meta's own explanation of why this Page is (or is about to
 * be) unable to message, shown before the first send fails.
 *
 * The counterpart to `PageSubscriptionWarning`: that one catches "connected but
 * Meta never delivers"; this one catches "connected, delivering, and Meta will
 * reject everything you send". Both are read live from Graph on page load rather
 * than mirrored, because both change on Meta's side without telling us.
 *
 * Deliberately renders NOTHING in two cases that look similar and are not:
 *
 *   - `integrity === null` — we could not ask (usually a missing
 *     `pages_manage_metadata`). Staying silent is right: an alarm we can't
 *     substantiate trains people to ignore the banner.
 *   - `status === "ok"` with no active restriction — genuinely healthy.
 *
 * Every string below except our own framing is Meta's: the violation
 * descriptions, the restriction descriptions and the appeal URLs are theirs, and
 * are shown verbatim. We can't write an accurate appeal link, and paraphrasing an
 * enforcement reason is how an operator ends up appealing the wrong thing.
 */
export interface PageIntegrity {
  status: string | null;
  blocksMessaging: boolean;
  restrictedUntil: string | null;
  violations: { type: string; description: string | null; url: string | null }[];
  restrictions: { feature: string; description: string | null; expiresAt: string | null }[];
  recommendedActions: { actionType: string; url: string | null }[];
  appeals: { type: string; status: string }[];
}

/** Meta's action_type → the label an operator should see on the link. */
const ACTION_LABEL: Record<string, string> = {
  FILE_APPEAL: "File an appeal",
  LEARN_MORE: "Learn more",
  SUPPORT_TICKET: "Open a support ticket",
};

export function PageIntegrityWarning({
  integrity,
  pageName,
}: {
  integrity: PageIntegrity | null | undefined;
  pageName?: string | null;
}) {
  if (!integrity) return null;
  const status = integrity.status?.toLowerCase() ?? null;
  const healthy = !integrity.blocksMessaging && (status === null || status === "ok");
  if (healthy) return null;

  // `blocksMessaging` — not the status word — decides the severity. A Page can
  // read `restricted` for something that has nothing to do with messaging
  // (page_read_only, page_publish), and shouting "you cannot reply" about a
  // posting restriction would be false.
  const severe = integrity.blocksMessaging || status === "suspended";
  const openAppeal = integrity.appeals.find((a) => {
    const s = a.status.toUpperCase();
    return s === "OPEN" || s === "OPENED";
  });

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-xl border p-4",
        severe
          ? "border-destructive/40 bg-destructive/10"
          : "border-warning-border bg-warning-bg",
      )}
      // Announced because it can appear on a page the operator already had open.
      role="status"
    >
      <div className="flex items-center gap-2">
        {severe ? (
          <AlertOctagon className="size-4 shrink-0 text-destructive" />
        ) : (
          <TriangleAlert className="size-4 shrink-0 text-warning-fg" />
        )}
        <p
          className={cn(
            "text-sm font-medium",
            severe ? "text-destructive" : "text-warning-fg",
          )}
        >
          {integrity.blocksMessaging
            ? `Meta has restricted ${pageName ?? "this Page"} from sending messages`
            : status === "suspended"
              ? `Meta has suspended ${pageName ?? "this Page"}`
              : `Meta has flagged ${pageName ?? "this Page"}`}
        </p>
      </div>

      {integrity.blocksMessaging && (
        <p className="text-xs text-muted-foreground">
          Replies and broadcasts on this Page will fail until it lifts
          {integrity.restrictedUntil
            ? // Deliberately the raw date rather than a countdown: this is read
              // once, and a relative "in 2 days" goes stale on a settings page
              // nobody re-opens.
              ` — Meta says ${new Date(integrity.restrictedUntil).toLocaleString()}`
            : ". Meta gave no end date"}
          .
        </p>
      )}

      {integrity.restrictions.length > 0 && (
        <ul className="flex flex-col gap-1">
          {integrity.restrictions.map((r, i) => (
            <li key={i} className="text-xs text-muted-foreground">
              <span className="font-medium">{r.feature}</span>
              {r.description ? ` — ${r.description}` : ""}
            </li>
          ))}
        </ul>
      )}

      {integrity.violations.length > 0 && (
        <ul className="flex flex-col gap-1">
          {integrity.violations.map((v, i) => (
            <li key={i} className="text-xs text-muted-foreground">
              <span className="font-medium">{v.type}</span>
              {v.description ? ` — ${v.description}` : ""}
              {v.url && (
                <>
                  {" "}
                  <a
                    href={v.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-primary hover:underline"
                  >
                    Read Meta&apos;s policy
                  </a>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {openAppeal ? (
        <p className="text-xs text-muted-foreground">
          An appeal is already open with Meta — no further action needed until
          they respond.
        </p>
      ) : (
        integrity.recommendedActions.length > 0 && (
          <div className="flex flex-wrap gap-3">
            {integrity.recommendedActions.map(
              (a, i) =>
                a.url && (
                  <a
                    key={i}
                    href={a.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs font-medium text-primary hover:underline"
                  >
                    {ACTION_LABEL[a.actionType] ?? a.actionType}
                  </a>
                ),
            )}
          </div>
        )
      )}
    </div>
  );
}
