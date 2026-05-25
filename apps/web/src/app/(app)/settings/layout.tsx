import { SectionShell } from "@/components/layouts/section-shell";
import { SettingsSubSidebar } from "@/components/layouts/settings-sub-sidebar";
import { getSession } from "@/lib/auth/current-user";

/**
 * Settings shell. The role-aware sub-sidebar gets the user's role for
 * the admin-only sections; everything else (AppRail, layout chrome) is
 * shared via SectionShell.
 */
export default async function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, permissions } = await getSession();

  return (
    <SectionShell
      subSidebar={<SettingsSubSidebar role={user.role} permissions={permissions} />}
    >
      <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6 md:px-8 md:py-10">{children}</div>
    </SectionShell>
  );
}
