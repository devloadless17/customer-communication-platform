import { redirect } from "next/navigation";

import { AdminSubSidebar } from "@/components/layouts/section-sub-sidebars";
import { SectionShell } from "@/components/layouts/section-shell";
import { getSession } from "@/lib/auth/current-user";

/**
 * Super-admin shell. Gates access at the layout level so every page under
 * /admin/* inherits the redirect — no need for per-page checks.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user } = await getSession();
  if (user.role !== "superAdmin") {
    redirect("/inbox");
  }

  return <SectionShell subSidebar={<AdminSubSidebar />}>{children}</SectionShell>;
}
