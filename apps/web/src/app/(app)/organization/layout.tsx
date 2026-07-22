import { SectionShell } from "@/components/layouts/section-shell";
import { OrganizationSubSidebar } from "@/components/layouts/organization-sub-sidebar";

/**
 * Organization — its OWN top-level section, deliberately NOT nested under
 * /settings.
 *
 * Two reasons, and the second is why it lives here rather than at
 * /settings/organization:
 *
 *  1. Meaning: everything under /settings configures the ONE workspace you are
 *     currently in. This section is about the layer above — the company, its
 *     people, and which workspaces exist. Sharing a sidebar blurs exactly the
 *     boundary a user needs to understand.
 *  2. Structure: `SectionShell` renders the sub-sidebar column. Nesting a
 *     second SectionShell inside the settings layout rendered the shell TWICE —
 *     two stacked sidebars and a broken content column. One section, one shell.
 */
export default function OrganizationLayout({ children }: { children: React.ReactNode }) {
  return (
    <SectionShell subSidebar={<OrganizationSubSidebar />} title="Organization">
      <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 md:px-8 md:py-10">
        {children}
      </div>
    </SectionShell>
  );
}
