import type { ReactNode } from "react";
import { KeyRound } from "lucide-react";

import { getSession } from "@/lib/auth/current-user";
import {
  getTeamInstagramConfig,
  getTeamMessengerConfig,
  getTeamMetaConfig,
  getTeamWebchatWidgets,
  getTeamWhatsappConfig,
} from "@/lib/api/queries";
import { canManageUsers } from "@ccp/shared/auth/permissions";
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
  status: "connected" | "not_connected" | "coming_soon";
}

export default async function ChannelsCatalogPage() {
  const { user } = await getSession();
  const canManage = canManageUsers(user.role);

  let metaReady = false;
  let wa = false;
  let msgr = false;
  let ig = false;
  let widgetCount = 0;
  if (canManage) {
    const [meta, w, m, i, widgets] = await Promise.all([
      getTeamMetaConfig().catch(() => null),
      getTeamWhatsappConfig().catch(() => null),
      getTeamMessengerConfig().catch(() => null),
      getTeamInstagramConfig().catch(() => null),
      getTeamWebchatWidgets().catch(() => []),
    ]);
    metaReady = Boolean(meta?.appSecret && meta?.systemUserToken);
    wa = Boolean(w?.phoneNumberId);
    msgr = Boolean(m?.pageId);
    ig = Boolean(i?.igId);
    widgetCount = widgets.filter((x) => x.isActive).length;
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
    },
    {
      key: "messenger",
      channel: "messenger",
      name: "Facebook Messenger",
      description: "Reply to your Facebook Page's Messenger conversations.",
      href: "/settings/messenger",
      connected: msgr,
      status: msgr ? "connected" : "not_connected",
    },
    {
      key: "instagram",
      channel: "instagram",
      name: "Instagram",
      description: "Manage Instagram DMs from your shared inbox.",
      href: "/settings/instagram",
      connected: ig,
      status: ig ? "connected" : "not_connected",
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
      status: widgetCount > 0 ? "connected" : "not_connected",
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
    status: metaReady ? "connected" : "not_connected",
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

      <Section title="Meta">
        <CatalogCard card={metaCard} canManage={canManage} />
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

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
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
