import Link from "next/link";
import {
  ArrowRight,
  BarChart3,
  Bell,
  Layers,
  ListChecks,
  MessageSquare,
  Plug,
  ShieldCheck,
  Sparkles,
  Tag as TagIcon,
  UserCircle2,
  Users,
  type LucideIcon,
} from "lucide-react";

import { getSession } from "@/lib/auth/current-user";
import { canManageUsers } from "@ccp/shared/auth/permissions";
import { AppearanceMode } from "./account/appearance-mode";

export const metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

/**
 * Single settings landing — one page, four permission-gated groups:
 * My account / Team & roles / Channels & integrations / Conversation config.
 *
 * Replaces the old split between "/settings" (titled "Team settings" but
 * holding conversation config) and "/settings/workspace" (titled "Account
 * settings" but holding WhatsApp/integrations) — names that were inverted vs
 * their contents and forced a double-hop to reach the profile form. The
 * sub-sidebar mirrors these same groups; /settings/workspace now redirects here.
 */
export default async function SettingsIndex() {
  const { user, permissions } = await getSession();
  const isAdmin = canManageUsers(user.role);

  const groups: Group[] = [
    {
      label: "My account",
      cards: [
        {
          href: "/settings/account",
          icon: UserCircle2,
          title: "Account",
          description: "Your name, email, and password.",
        },
        {
          href: "/settings/notifications",
          icon: Bell,
          title: "Notifications",
          description: "New-message sounds — personal, per device.",
        },
      ],
    },
    {
      label: "Team & roles",
      cards: [
        {
          href: "/settings/team",
          icon: Users,
          title: "Team members",
          description: isAdmin
            ? "Invite teammates, change roles, deactivate accounts."
            : "See who else is on this team.",
        },
        ...(isAdmin
          ? [
              {
                href: "/settings/permissions",
                icon: ShieldCheck,
                title: "Role permissions",
                description:
                  "What each role (admin / manager / agent) is allowed to do.",
              } satisfies Card,
            ]
          : []),
        ...(permissions["teamActivity:view"]
          ? [
              {
                href: "/settings/activity",
                icon: BarChart3,
                title: "Team activity",
                description:
                  "Per-member assigned / messages-sent / resolved counts.",
              } satisfies Card,
            ]
          : []),
      ],
    },
    ...(isAdmin
      ? [
          {
            label: "Channels & integrations",
            cards: [
              {
                href: "/settings/whatsapp",
                icon: MessageSquare,
                title: "WhatsApp",
                description:
                  "Meta Cloud API credentials, phone number, and template catalog.",
              },
              {
                href: "/settings/integrations",
                icon: Plug,
                title: "Integrations",
                description:
                  "n8n, webhooks, Make, Zapier — connect external tools to this workspace.",
              },
            ],
          } satisfies Group,
        ]
      : []),
    {
      label: "Conversation config",
      cards: [
        ...(permissions["snippets:manage"]
          ? [
              {
                href: "/settings/snippets",
                icon: Sparkles,
                title: "Snippets",
                description:
                  "Saved canned replies your team triggers with /name in the composer.",
              } satisfies Card,
            ]
          : []),
        ...(permissions["tags:manage"]
          ? [
              {
                href: "/settings/tags",
                icon: TagIcon,
                title: "Tags",
                description:
                  "Labels for segmenting contacts — drives the contacts filter and broadcast audiences.",
              } satisfies Card,
            ]
          : []),
        ...(permissions["stages:manage"]
          ? [
              {
                href: "/settings/stages",
                icon: Layers,
                title: "Stages",
                description:
                  "Lifecycle buckets (New → Qualified → …) for contacts — drives filtering and stage-targeted broadcasts.",
              } satisfies Card,
            ]
          : []),
        ...(permissions["contactFields:manage"]
          ? [
              {
                href: "/settings/contact-fields",
                icon: ListChecks,
                title: "Contact fields",
                description:
                  "Custom fields shown on every contact (order ID, plan, company size…).",
              } satisfies Card,
            ]
          : []),
      ],
    },
  ].filter((g) => g.cards.length > 0);

  return (
    <div>
      <header className="mb-8">
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Your account, your team, the channels you connect, and how
          conversations are configured.
        </p>
      </header>

      <section className="mb-8 rounded-xl border border-border bg-card p-5">
        <div className="mb-4">
          <div className="text-sm font-medium">Appearance</div>
          <div className="text-2xs text-muted-foreground">
            Light or dark mode. “System” follows your device. Applies to your
            account on this device.
          </div>
        </div>
        <AppearanceMode />
      </section>

      {groups.map((g) => (
        <section key={g.label} className="mb-8">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {g.label}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {g.cards.map((c) => (
              <SettingsCard key={c.href} {...c} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

interface Card {
  href: string;
  icon: LucideIcon;
  title: string;
  description: string;
}
interface Group {
  label: string;
  cards: Card[];
}

function SettingsCard({ href, icon: Icon, title, description }: Card) {
  return (
    <Link
      href={href}
      className="group flex items-start gap-3 rounded-lg border border-border bg-card p-4 transition-colors hover:border-foreground/20 hover:bg-accent/30"
    >
      <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground transition-colors group-hover:bg-primary/10 group-hover:text-primary">
        <Icon className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium">{title}</span>
          <ArrowRight className="size-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-100" />
        </div>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
          {description}
        </p>
      </div>
    </Link>
  );
}
