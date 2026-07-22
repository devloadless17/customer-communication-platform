import { SectionShell } from "@/components/layouts/section-shell";
import { TicketsSubSidebar } from "@/components/layouts/tickets-sub-sidebar";

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
export default function TicketsLayout({ children }: { children: React.ReactNode }) {
  return (
    <SectionShell subSidebar={<TicketsSubSidebar />} mainClassName="overflow-hidden">
      {children}
    </SectionShell>
  );
}
