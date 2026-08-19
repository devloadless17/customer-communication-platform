import type { ReactNode } from "react";
import { KeyRound } from "lucide-react";

import { getSession } from "@/lib/auth/current-user";
import {
  getTeamInstagramConfig,
  getTeamMessengerConfig,
  getTeamMetaConfig,
  getTeamWebchatWidgets,
  getTeamWhatsappConfig,
  listChannelAccountDirectory,
} from "@/lib/api/queries";
import { canManageUsers } from "@ccp/shared/auth/permissions";
import { soft } from "@/lib/api/soft";
import { PageHeader } from "@/components/layouts/page-header";
import { ChannelBadge } from "@/features/inbox/components/channel-badge";
import type { Channel } from "@ccp/shared/types";

export const metadata = { title: "Channels · Settings" };
export const dynamic = "force-dynamic";

interface CardModel {
  key: string;
  name: string;
  description: string;
  href: string;
  channel?: Channel;
  icon?: ReactNode;
  connected: boolean;
  /** `unknown` = this viewer has no route that can answer it (see below) — a
   *  different state from "not connected", which is an answer. */
  status: "connected" | "not_connected" | "unknown" | "coming_soon";
  /**
   * How many accounts are connected on this channel, and what one is called.
   * A workspace can hold several WhatsApp numbers / Pages / handles, and the
   * catalog said only "Connected" — so a two-number workspace looked identical
   * to a one-number one, which is exactly the question this page should answer.
   * Absent on Meta-App and coming-soon cards.
   */
  accountCount?: number;
  accountNoun?: string;
}

export default async function ChannelsCatalogPage() {
  const { user } = await getSession();
  const canManage = canManageUsers(user.role);

  let metaReady = false;
  let wa = false;
  let msgr = false;
  let ig = false;
  let widgetCount = 0;
  // Per-channel account counts. The four `getTeam*Config` reads above only ever
  // describe the DEFAULT account, so they can't tell "connected" from
  // "connected, three of them".
  const accountCounts = new Map<string, number>();
  if (canManage) {
    const [meta, w, m, i, widgets, directory] = await Promise.all([
      // Each card degrades independently — one unreachable channel must not
      // blank the catalog — but every failure is logged, because "Not
      // connected" and "we couldn't ask" look identical on this page.
      soft("meta app config", null, () => getTeamMetaConfig()),
      soft("whatsapp config", null, () => getTeamWhatsappConfig()),
      soft("messenger config", null, () => getTeamMessengerConfig()),
      soft("instagram config", null, () => getTeamInstagramConfig()),
      soft("webchat widgets", [], () => getTeamWebchatWidgets()),
      soft("channel-account directory", [], () => listChannelAccountDirectory()),
    ]);
    metaReady = Boolean(meta?.appSecret && meta?.systemUserToken);
    wa = Boolean(w?.phoneNumberId);
    msgr = Boolean(m?.pageId);
    ig = Boolean(i?.igId);
    widgetCount = widgets.filter((x) => x.isActive).length;
    for (const a of directory) {
      accountCounts.set(a.channel, (accountCounts.get(a.channel) ?? 0) + 1);
    }
  } else {
    // Every `getTeam*Config` above is admin-only, so a non-admin used to read
    // "Not connected" on every card while their inbox was taking messages on
    // all of them. Connectedness is not a credential: the member-open account
    // directory answers it for the Meta channels. The Meta app and the widget
    // list have no member-open equivalent, so those two cards say "unknown"
    // rather than guessing (see `status` below).
    const directory = await soft("channel-account directory", [], () =>
      listChannelAccountDirectory(),
    );
    for (const a of directory) {
      accountCounts.set(a.channel, (accountCounts.get(a.channel) ?? 0) + 1);
    }
    wa = (accountCounts.get("whatsapp") ?? 0) > 0;
    msgr = (accountCounts.get("messenger") ?? 0) > 0;
    ig = (accountCounts.get("instagram") ?? 0) > 0;
  }

  const live: CardModel[] = [
    {
      key: "whatsapp",
      channel: "whatsapp",
      name: "WhatsApp",
      description: "Two-way WhatsApp Business messaging, templates, and broadcasts.",
      href: "/settings/whatsapp",
      connected: wa,
      status: wa ? "connected" : "not_connected",
      accountCount: accountCounts.get("whatsapp") ?? 0,
      accountNoun: "number",
    },
    {
      key: "messenger",
      channel: "messenger",
      name: "Facebook Messenger",
      description: "Reply to your Facebook Page's Messenger conversations.",
      href: "/settings/messenger",
      connected: msgr,
      status: msgr ? "connected" : "not_connected",
      accountCount: accountCounts.get("messenger") ?? 0,
      accountNoun: "Page",
    },
    {
      key: "instagram",
      channel: "instagram",
      name: "Instagram",
      description: "Manage Instagram DMs from your shared inbox.",
      href: "/settings/instagram",
      connected: ig,
      status: ig ? "connected" : "not_connected",
      accountCount: accountCounts.get("instagram") ?? 0,
      accountNoun: "account",
    },
  ];

  const firstParty: CardModel[] = [
    {
      key: "webchatwidget",
      channel: "webchatwidget",
      name: "Website chat",
      description:
        "Embed a chat widget on any website — one per site. Visitor messages land in your inbox.",
      href: "/settings/webchatwidget",
      connected: widgetCount > 0,
      // The widget list is admin-only and has no directory equivalent.
      status: !canManage ? "unknown" : widgetCount > 0 ? "connected" : "not_connected",
      accountCount: widgetCount,
      accountNoun: "widget",
    },
  ];

  const comingSoon: CardModel[] = [
    {
      key: "telegram",
      channel: "telegram",
      name: "Telegram",
      description: "Connect a Telegram bot for real-time support.",
      href: "#",
      connected: false,
      status: "coming_soon",
    },
    {
      key: "email",
      channel: "email",
      name: "Email",
      description: "Turn a shared mailbox into inbox conversations.",
      href: "#",
      connected: false,
      status: "coming_soon",
    },
    {
      key: "sms",
      channel: "sms",
      name: "SMS",
      description: "Two-way SMS over a provisioned number.",
      href: "#",
      connected: false,
      status: "coming_soon",
    },
  ];

  const metaCard: CardModel = {
    key: "meta",
    name: "Meta App",
    description:
      "Shared credentials for every Meta channel — set your App secret + system-user token once.",
    href: "/settings/meta",
    icon: (
      <span className="inline-flex size-11 items-center justify-center rounded-full bg-[#1877F2]/10 text-[#1877F2]">
        <KeyRound className="size-6" />
      </span>
    ),
    connected: metaReady,
    // The app's credentials are admin-only, and nothing member-open describes them.
    status: !canManage ? "unknown" : metaReady ? "connected" : "not_connected",
  };

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8">
      <PageHeader
        title="Channels"
        description="Connect your messaging channels so every conversation lands in one shared inbox."
      />

      {!metaReady && canManage && (
        <a
          href="/settings/meta"
          className="flex items-center justify-between gap-4 rounded-xl border border-primary/30 bg-primary/5 p-4 transition hover:bg-primary/10"
        >
          <div className="flex items-center gap-3">
            <span className="inline-flex size-9 items-center justify-center rounded-full bg-[#1877F2]/10 text-[#1877F2]">
              <KeyRound className="size-5" />
            </span>
            <div>
              <p className="text-sm font-medium">Set up your Meta App first</p>
              <p className="text-xs text-muted-foreground">
                WhatsApp, Messenger, and Instagram all share one App secret + token.
              </p>
            </div>
          </div>
          <span className="shrink-0 text-xs font-medium text-primary">Set up →</span>
        </a>
      )}

      {/* The Meta app is the LAYER UNDER the three Meta channels, not a fourth
          channel beside them. Listing all four as peers in one grid was the whole
          reason "which app do my accounts use?" read as unanswerable: nothing on
          this page said the relationship existed. So the app gets its own labelled
          band, and the channels that draw on it are grouped beneath it. */}
      <Section
        title="Meta app"
        hint="Credentials shared by WhatsApp, Messenger and Instagram. One app can serve every account you connect — and an account can run on a different app if you connect it with that app's credentials."
      >
        <CatalogCard card={metaCard} canManage={canManage} />
      </Section>

      <Section
        title="Meta channels"
        hint="Each channel holds as many accounts as you need — numbers, Pages or handles. Open one to see its accounts and add another."
      >
        {live.map((c) => (
          <CatalogCard key={c.key} card={c} canManage={canManage} />
        ))}
      </Section>

      <Section title="Your website">
        {firstParty.map((c) => (
          <CatalogCard key={c.key} card={c} canManage={canManage} />
        ))}
      </Section>

      <Section title="Coming soon">
        {comingSoon.map((c) => (
          <CatalogCard key={c.key} card={c} canManage={canManage} />
        ))}
      </Section>
    </div>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  /** One line saying what this group IS — the relationship, not a feature pitch. */
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h2>
        {hint && <p className="max-w-3xl text-2xs leading-relaxed text-muted-foreground">{hint}</p>}
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {children}
      </div>
    </div>
  );
}

function CatalogCard({ card, canManage }: { card: CardModel; canManage: boolean }) {
  const comingSoon = card.status === "coming_soon";
  const clickable = canManage && !comingSoon;
  const body = (
    <div
      className={`flex h-full flex-col gap-3 rounded-xl border bg-card p-5 transition ${
        clickable ? "hover:border-primary/40 hover:shadow-sm" : ""
      } ${comingSoon ? "opacity-60" : ""}`}
    >
      <div className="flex items-start justify-between gap-3">
        {card.icon ?? (card.channel && <ChannelBadge channel={card.channel} className="size-11" />)}
        <StatusPill status={card.status} />
      </div>
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold">{card.name}</h3>
        <p className="text-xs leading-relaxed text-muted-foreground">{card.description}</p>
        {/* The count is the ANSWER to "how many accounts do I have on this
            channel", so it reads as a figure, not as a footnote. Driven by the
            account directory rather than by `connected` (which only ever described
            the DEFAULT account), so it stays truthful even when the default is
            mid-reconnect. */}
        {card.accountCount != null && card.accountCount > 0 && card.accountNoun && (
          <p className="text-xs">
            <span className="font-semibold tabular-nums">{card.accountCount}</span>{" "}
            <span className="text-muted-foreground">
              {card.accountNoun}
              {card.accountCount === 1 ? "" : "s"} connected
            </span>
          </p>
        )}
      </div>
      {clickable && (
        <div className="mt-auto pt-2">
          <span className="inline-flex items-center rounded-md border px-3 py-1.5 text-xs font-medium transition group-hover:border-primary group-hover:text-primary">
            {card.connected ? "Manage" : "Connect"}
          </span>
        </div>
      )}
    </div>
  );

  if (!clickable) return <div className="group">{body}</div>;
  return (
    <a href={card.href} className="group block">
      {body}
    </a>
  );
}

function StatusPill({ status }: { status: CardModel["status"] }) {
  if (status === "connected") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-2xs font-medium text-emerald-600">
        <span className="size-1.5 rounded-full bg-emerald-500" />
        Connected
      </span>
    );
  }
  if (status === "unknown") {
    return (
      <span className="rounded-full border border-dashed px-2 py-0.5 text-2xs font-medium text-muted-foreground">
        Admins only
      </span>
    );
  }
  if (status === "coming_soon") {
    return (
      <span className="rounded-full bg-muted px-2 py-0.5 text-2xs font-medium text-muted-foreground">
        Coming soon
      </span>
    );
  }
  return (
    <span className="rounded-full border px-2 py-0.5 text-2xs font-medium text-muted-foreground">
      Not connected
    </span>
  );
}
