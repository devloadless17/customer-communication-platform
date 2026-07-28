import { SectionShell } from "@/components/layouts/section-shell";

/**
 * Reports shell. No sub-sidebar: the dashboard is one page with its own
 * range controls, so a nav column would be an empty strip. `capContentWidth`
 * keeps the charts readable on ultrawide monitors.
 */
export default function ReportsLayout({ children }: { children: React.ReactNode }) {
  return (
    <SectionShell title="Reports" capContentWidth>
      {children}
    </SectionShell>
  );
}
