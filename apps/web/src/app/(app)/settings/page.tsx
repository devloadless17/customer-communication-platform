import Link from "next/link";
import {
  ArrowRight,
  BarChart3,
  Layers,
  Building2,
  ListChecks,
  Ticket as TicketIcon,
  MessagesSquare,
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
import { PageHeader } from "@/components/layouts/page-header";
import { AppearanceMode } from "@/app/(app)/account/appearance-mode";

export const metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

/**
 * WORKSPACE settings landing — everything here configures the workspace you
 * are currently in.
 *
 * Two sibling areas own the other scopes, linked at the top of this page:
 *   /organization → the company: its workspaces and its people
 *   /account      → you: profile, password, notifications
 *
 * That three-way split replaced a single page that mixed all three scopes under
 * one heading, which made "settings" mean three different things at once.
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
      // The layer ABOVE workspaces. First, because it answers "where am I" —
      // which workspace you are configuring only makes sense once you know the
      // org holds several.
      label: "Other settings areas",
      cards: [
        {
          href: "/organization",
          icon: Building2,
          title: "Organization",
          description:
            "Your company: the workspaces it holds, and who can reach each one.",
        },
        {
          href: "/account",
          icon: UserCircle2,
          title: "Personal settings",
          description:
            "Your profile, password and notification sounds — they follow you across workspaces.",
        },
      ],
    },
    {
      label: "People & teams",
      cards: [
        {
          href: "/settings/members",
          icon: Users,
          title: "Members",
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
            label: "Channels & apps",
            cards: [
              {
                href: "/settings/channels",
                icon: MessagesSquare,
                title: "Channels",
                description:
                  "Connect WhatsApp, Messenger, and Instagram so every conversation lands in one shared inbox.",
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
      label: "Inbox",
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
        // Admin-gated on the ROLE, not a capability: every route under
        // /api/workspace/tickets is @RequireRole("admin"), so surfacing this card to
        // anyone else would land them on the error boundary.
        ...(isAdmin
          ? [
              {
                href: "/settings/tickets",
                icon: TicketIcon,
                title: "Tickets",
                description:
                  "When work opens by itself, how long a solved ticket stays reopenable, and what each priority promises.",
              } satisfies Card,
            ]
          : []),
      ],
    },
  ].filter((g) => g.cards.length > 0);

  return (
    <div>
      <PageHeader
        title="Settings"
        description="Your account, your team, the channels you connect, and how conversations are configured."
        className="mb-8"
      />

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
          <h2 className="mb-3 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
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
      className="group flex items-start gap-3 rounded-lg border border-border bg-card p-4 transition-colors hover:border-foreground/20 hover:bg-accent/50"
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
