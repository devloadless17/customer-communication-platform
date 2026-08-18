import { ContactsSubSidebar } from "@/components/layouts/contacts-sub-sidebar";
import { SectionShell } from "@/components/layouts/section-shell";
import {
  getContactSegmentCounts,
  listAudienceGroups,
  listContactStages,
} from "@/lib/api/queries";

/**
 * Contacts shell — stages and audience groups are SSR-seeded so the
 * sub-sidebar paints with real data on first load.
 */
export default async function ContactsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [stages, audienceGroups, segmentCounts] = await Promise.all([
    listContactStages(),
    listAudienceGroups(),
    // Badge counts. Soft-failed: the sub-sidebar is navigation, and a counts
    // hiccup must not take the whole contacts section down with it — without
    // them the Channels group simply doesn't render.
    getContactSegmentCounts().catch(() => undefined),
  ]);

  return (
    <SectionShell
      subSidebar={
        <ContactsSubSidebar
          stages={stages}
          audienceGroups={audienceGroups}
          segmentCounts={segmentCounts}
        />
      }
    >
      {children}
    </SectionShell>
  );
}
