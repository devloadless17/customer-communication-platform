import Link from "next/link";
import {
  ArrowRight,
  Layers,
  ListChecks,
  Sparkles,
  Tag as TagIcon,
  type LucideIcon,
} from "lucide-react";

import { getSession } from "@/lib/auth/current-user";
import { AppearanceMode } from "./account/appearance-mode";

export const metadata = { title: "Team settings" };
export const dynamic = "force-dynamic";

/**
 * Team settings landing — shared conversation-flow config that affects how
 * everyone on the team replies and routes customers. Account / workspace
 * plumbing lives one level over at /settings/workspace.
 */
export default async function TeamSettingsIndex() {
  const { permissions } = await getSession();
  const canStages = permissions["stages:manage"];
  const canFields = permissions["contactFields:manage"];

  const cards: Card[] = [
    {
      href: "/settings/snippets",
      icon: Sparkles,
      title: "Snippets",
      description:
        "Saved canned replies your team triggers with `/name` in the reply box.",
    },
    {
      href: "/settings/tags",
      icon: TagIcon,
      title: "Tags",
      description:
        "Labels for segmenting contacts. Drives the contacts filter and tag-based broadcast audiences.",
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
    ...(canFields
      ? [
          {
            href: "/settings/contact-fields",
            icon: ListChecks,
            title: "Contact fields",
            description:
              "Custom fields shown on every contact (order ID, plan, company size…). Add or remove the field once for the whole team.",
          } satisfies Card,
        ]
      : []),
  ];

  return (
    <div>
      <header className="mb-8">
        <h1 className="text-2xl font-semibold">Team settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          How your team replies and routes customers — shared across everyone
          in the workspace.
        </p>
      </header>

      <section className="mb-8 rounded-xl border border-border bg-card p-5">
        <div className="mb-4">
          <div className="text-sm font-medium">Mode</div>
          <div className="text-[11px] text-muted-foreground">
            Light or dark mode. “System” follows your device. Applies to your
            account on this device.
          </div>
        </div>
        <AppearanceMode />
      </section>

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
