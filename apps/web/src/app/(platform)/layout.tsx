import { redirect } from "next/navigation";

import { PlatformRail } from "@/components/layouts/platform-rail";
import { getSession } from "@/lib/auth/current-user";

/**
 * Super-admin platform shell. A standalone management surface — org approvals,
 * suspensions, and platform analytics — with its OWN rail. Deliberately does
 * NOT mount the customer {@link AppRail}: a super-admin never sees the inbox,
 * contacts, broadcasts, or workflows. The customer (app) layout reciprocally
 * redirects super-admins here, so the two shells never overlap.
 *
 * Gated at the layout level so every /platform/* page inherits the check.
 */
export default async function PlatformLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user } = await getSession();
  if (user.role !== "superAdmin") redirect("/inbox");

  return (
    <div className="flex h-svh w-full flex-col overflow-hidden bg-background text-foreground md:flex-row">
      <PlatformRail
        user={{ name: user.name, email: user.email, role: user.role }}
      />
      <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
