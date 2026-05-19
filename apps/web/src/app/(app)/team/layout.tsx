import { SectionShell } from "@/components/layouts/section-shell";

/**
 * Team chat shell. No sub-sidebar — the channel list (the contextual nav
 * for this section) is owned by `TeamChatWorkspace` because it carries
 * live socket state (unread badges, member presence). Putting a second
 * channel list in the layout would either duplicate the data or force
 * the workspace to refetch on every channel switch.
 *
 * `min-w-0` on main lets the workspace own its own internal scroll.
 */
export default async function TeamLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <SectionShell mainClassName="min-w-0">{children}</SectionShell>;
}
