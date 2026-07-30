import Link from "next/link";

import { ChannelBadge } from "@/features/inbox/components/channel-badge";
import type { ChannelAccountView } from "@/lib/api/queries";
import type { Channel } from "@ccp/shared/types";

/**
 * Which accounts this Meta app actually serves — the blast radius of the page
 * it sits on.
 *
 * Meta's model is one app ↔ many accounts: a single app can carry every WhatsApp
 * number, Page and Instagram account a workspace connects. The settings UI showed
 * the app on one page and the accounts on three others, with nothing joining them,
 * so two questions had no in-product answer:
 *
 *   1. "Which of my accounts does this app run?" — i.e. what am I about to affect
 *      by rotating this secret.
 *   2. "If I add another Meta app, which accounts take from which?" — invisible,
 *      even though the model already supports it per account.
 *
 * The second is why the own-app group is listed even when empty-by-implication:
 * an account on its own app is precisely the one a shared rotation will NOT touch,
 * and discovering that from a silently-skipped resync is the wrong way to learn it.
 */
export function MetaAppAccounts({
  accounts,
  hasSharedApp,
}: {
  accounts: ChannelAccountView[];
  /** False before any shared credentials are saved — changes what "shared" means. */
  hasSharedApp: boolean;
}) {
  if (accounts.length === 0) {
    return (
      <section className="rounded-xl border bg-card p-4">
        <h2 className="text-sm font-semibold">Accounts using this app</h2>
        <p className="mt-1 text-2xs text-muted-foreground">
          None yet. One Meta app can serve every WhatsApp number, Facebook Page and
          Instagram account you connect —{" "}
          <Link href="/settings/channels" className="underline hover:no-underline">
            connect a channel
          </Link>{" "}
          and it will appear here.
        </p>
      </section>
    );
  }

  const shared = accounts.filter((a) => a.appBinding === "shared_app");
  const own = accounts.filter((a) => a.appBinding === "own_app");
  const unset = accounts.filter((a) => a.appBinding === "unset");

  return (
    <section className="rounded-xl border bg-card p-4">
      <h2 className="text-sm font-semibold">Accounts using this app</h2>
      <p className="mt-1 text-2xs leading-relaxed text-muted-foreground">
        One Meta app can serve many accounts across WhatsApp, Messenger and Instagram.
        Each account keeps its own copy of the credentials, so an account can instead run
        on a <span className="font-medium text-foreground/80">different</span> Meta app —
        connect it with that app&apos;s secret and token and it moves to the group below.
      </p>

      <Group
        title={hasSharedApp ? "On this app" : "Waiting for this app"}
        count={shared.length}
        note={
          hasSharedApp
            ? "Saving new credentials above updates every account here."
            : "These have no app secret of their own — save credentials above and they will use them."
        }
        accounts={shared}
      />

      {own.length > 0 && (
        <Group
          title="On their own Meta app"
          count={own.length}
          note="Not affected by changes above — each was connected with a different app's credentials. To move one onto this app, re-save it with this app's secret and token."
          accounts={own}
          showAppId
        />
      )}

      {unset.length > 0 && (
        <Group
          title="No app credentials"
          count={unset.length}
          note="No app secret is stored, so Meta has nothing to sign these accounts' webhooks with and inbound may be rejected. Re-save their credentials."
          accounts={unset}
          tone="warning"
        />
      )}
    </section>
  );
}

function Group({
  title,
  count,
  note,
  accounts,
  showAppId = false,
  tone = "default",
}: {
  title: string;
  count: number;
  note: string;
  accounts: ChannelAccountView[];
  showAppId?: boolean;
  tone?: "default" | "warning";
}) {
  if (accounts.length === 0) return null;
  return (
    <div className="mt-3">
      <div className="flex items-baseline gap-1.5">
        <h3
          className={
            tone === "warning"
              ? "text-2xs font-semibold uppercase tracking-wide text-warning-fg"
              : "text-2xs font-semibold uppercase tracking-wide text-muted-foreground"
          }
        >
          {title}
        </h3>
        <span className="text-2xs tabular-nums text-muted-foreground">{count}</span>
      </div>
      <p className="mt-0.5 text-3xs leading-relaxed text-muted-foreground">{note}</p>
      <ul className="mt-1.5 flex flex-col gap-1">
        {accounts.map((a) => (
          <li key={a.id} className="flex items-center gap-2 rounded-lg border px-2.5 py-1.5">
            <ChannelBadge channel={a.channel as Channel} className="size-5 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-xs">
              {accountName(a)}
              {a.isDefault && (
                <span className="ml-1.5 text-3xs text-muted-foreground">default</span>
              )}
            </span>
            {showAppId && a.appId && (
              <span className="shrink-0 font-mono text-3xs text-muted-foreground">
                {a.appId}
              </span>
            )}
            <Link
              href={`/settings/${a.channel}`}
              className="shrink-0 text-3xs text-muted-foreground underline hover:text-foreground hover:no-underline"
            >
              Manage
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Same fallback chain the accounts panel uses — blank labels are not names. */
function accountName(a: ChannelAccountView): string {
  for (const v of [a.label, a.displayPhoneNumber, a.externalAccountId]) {
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return "Unnamed account";
}
