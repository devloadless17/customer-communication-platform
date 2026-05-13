import Link from "next/link";
import {
  ArrowRight,
  KeyRound,
  Layers,
  MessageSquare,
  Sparkles,
  Users,
  UserCircle2,
  type LucideIcon,
} from "lucide-react";

import { getSession } from "@/lib/current-user";
import { canManageStages, canManageUsers } from "@/lib/permissions";

export const metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

/**
 * Settings landing page. Two groups of cards so admins can see at a glance
 * where each knob lives:
 *
 *   Chat       → conversation-flow stuff (snippets, stages, …)
 *   Workspace  → identity + plumbing (account, team, WhatsApp, API keys)
 *
 * Admin-only cards hide for everyone else; the page is still useful to
 * agents (Account, Team, Snippets are visible to everyone).
 */
export default async function SettingsIndex() {
  const { user } = await getSession();
  const isAdmin = canManageUsers(user.role);
  const canStages = canManageStages(user.role);

  const chatCards: Card[] = [
    {
      href: "/settings/snippets",
      icon: Sparkles,
      title: "Snippets",
      description:
        "Saved canned replies your team triggers with `/name` in the reply box.",
    },
    ...(canStages
      ? [
          {
            href: "/settings/stages",
            icon: Layers,
            title: "Stages",
            description:
              "Lifecycle buckets for contacts (New → Qualified → …). Drives filtering and stage-targeted broadcasts.",
          } satisfies Card,
        ]
      : []),
  ];

  const workspaceCards: Card[] = [
    {
      href: "/settings/account",
      icon: UserCircle2,
      title: "Account",
      description: "Your name, email, and password.",
    },
    {
      href: "/settings/team",
      icon: Users,
      title: "Team",
      description: isAdmin
        ? "Invite teammates, change roles, deactivate accounts."
        : "See who else is on this team.",
    },
    ...(isAdmin
      ? [
          {
            href: "/settings/whatsapp",
            icon: MessageSquare,
            title: "WhatsApp",
            description:
              "Meta Cloud API credentials, phone number, and template catalog.",
          } satisfies Card,
          {
            href: "/settings/api-keys",
            icon: KeyRound,
            title: "API keys",
            description: "Bearer tokens for the external /api/external/v1 endpoints.",
          } satisfies Card,
        ]
      : []),
  ];

  return (
    <div>
      <header className="mb-8">
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Everything that shapes how your team handles conversations, plus
          your workspace plumbing — all in one place.
        </p>
      </header>

      <Section title="Chat" description="How agents reply and route customers.">
        <CardGrid cards={chatCards} />
      </Section>

      <Section
        title="Workspace"
        description="Your account, team roster, and integration credentials."
      >
        <CardGrid cards={workspaceCards} />
      </Section>
    </div>
  );
}

interface Card {
  href: string;
  icon: LucideIcon;
  title: string;
  description: string;
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-10">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h2>
      <p className="mt-0.5 text-xs text-muted-foreground/80">{description}</p>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function CardGrid({ cards }: { cards: Card[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {cards.map((c) => (
        <SettingsCard key={c.href} {...c} />
      ))}
    </div>
  );
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
          <ArrowRight className="size-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
        </div>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
          {description}
        </p>
      </div>
    </Link>
  );
}
