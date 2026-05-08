import Link from "next/link";
import { ArrowLeft, Inbox, ContactRound } from "lucide-react";

import { getSession } from "@/lib/current-user";

/**
 * Contacts shell. Mirrors the settings layout — left rail with a "back to
 * inbox" link plus contact-related nav. Today there's just one entry but
 * the structure is here for /contacts/segments, /contacts/imports, etc.
 */
export default async function ContactsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await getSession();

  return (
    <div className="grid min-h-svh grid-cols-[220px_1fr] bg-background text-foreground">
      <aside className="flex flex-col border-r border-border bg-sidebar text-sidebar-foreground">
        <div className="px-4 pt-5 pb-3">
          <Link
            href="/inbox"
            className="inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" />
            Back to inbox
          </Link>
        </div>
        <div className="px-4 pb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Contacts
        </div>
        <nav className="flex flex-col gap-0.5 px-2">
          <NavLink href="/contacts" icon={<ContactRound className="size-4" />}>
            All contacts
          </NavLink>
          <NavLink href="/inbox" icon={<Inbox className="size-4" />}>
            Inbox
          </NavLink>
        </nav>
      </aside>
      <main className="overflow-y-auto">{children}</main>
    </div>
  );
}

function NavLink({
  href,
  icon,
  children,
}: {
  href: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
    >
      {icon}
      <span>{children}</span>
    </Link>
  );
}
