import Link from "next/link";
import {
  ArrowRight,
  KeyRound,
  MessageSquare,
  UserCircle2,
  Users,
  type LucideIcon,
} from "lucide-react";

import { getSession } from "@/lib/auth/current-user";
import { canManageUsers } from "@ccp/shared/auth/permissions";

export const metadata = { title: "Account settings" };
export const dynamic = "force-dynamic";

/**
 * Account settings landing — identity + integration plumbing. Pair with
 * /settings (Team settings) for the conversation-flow knobs. Admin-only
 * cards hide for agents; Account + Team stay visible to everyone.
 */
export default async function WorkspaceSettingsIndex() {
  const { user } = await getSession();
  const isAdmin = canManageUsers(user.role);

  const cards: Card[] = [
    {
      href: "/settings/account",
      icon: UserCircle2,
      title: "Account",
      description: "Your name, email, and password.",
    },
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
        <h1 className="text-2xl font-semibold">Account settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Your profile, the team roster, and the integrations that connect
          this workspace to WhatsApp and external systems.
        </p>
      </header>

      <CardGrid cards={cards} />
    </div>
  );
}

interface Card {
  href: string;
  icon: LucideIcon;
  title: string;
  description: string;
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
