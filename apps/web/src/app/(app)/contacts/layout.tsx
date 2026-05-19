import { ContactsSubSidebar } from "@/components/layouts/contacts-sub-sidebar";
import { SectionShell } from "@/components/layouts/section-shell";
import { listAudienceGroups, listContactStages } from "@/lib/api/queries";

/**
 * Contacts shell — stages and audience groups are SSR-seeded so the
 * sub-sidebar paints with real data on first load.
 */
export default async function ContactsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [stages, audienceGroups] = await Promise.all([
    listContactStages(),
    listAudienceGroups(),
  ]);

  return (
    <SectionShell
      subSidebar={<ContactsSubSidebar stages={stages} audienceGroups={audienceGroups} />}
    >
      {children}
    </SectionShell>
  );
}
