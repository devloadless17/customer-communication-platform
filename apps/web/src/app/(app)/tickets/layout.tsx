import { SectionShell } from "@/components/layouts/section-shell";
import { TicketsSubSidebar } from "@/components/layouts/tickets-sub-sidebar";
import { getSession } from "@/lib/auth/current-user";

/**
 * Tickets shell.
 *
 * This section shipped without a layout, so it rendered bare inside the app
 * shell: no sub-sidebar, no padding, no mobile chrome — the page title sat
 * flush against the viewport edge while every sibling section had a left rail.
 *
 * `mainClassName` keeps `overflow-hidden` because the BOARD owns its own
 * scrolling: columns scroll vertically inside themselves and the row scrolls
 * horizontally. A scrolling `<main>` would give the page a second scrollbar and
 * let the whole board slide under the header.
 */
export default async function TicketsLayout({ children }: { children: React.ReactNode }) {
  // The role decides whether the "Ticket settings" link is offered at all —
  // every `/api/workspace/tickets` route is `@RequireRole("admin")`, so
  // showing it to an agent is a link whose only outcome is an error page.
  const { user } = await getSession();
  return (
    <SectionShell
      subSidebar={<TicketsSubSidebar isAdmin={user.role === "admin"} />}
      mainClassName="overflow-hidden"
    >
      {children}
    </SectionShell>
  );
}
