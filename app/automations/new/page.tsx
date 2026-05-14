import { redirect } from "next/navigation";

import { getSession } from "@/lib/auth/current-user";
import { canManageUsers } from "@/lib/auth/permissions";

import { AutomationForm } from "@/components/automations/automation-form";

export const metadata = { title: "New automation" };
export const dynamic = "force-dynamic";

export default async function NewAutomationPage() {
  const { user } = await getSession();
  if (!canManageUsers(user.role)) {
    redirect("/automations");
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-8">
      <header>
        <h1 className="text-xl font-semibold">New automation</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          When the trigger fires and every condition matches, your webhook URL
          will receive a JSON payload via POST.
        </p>
      </header>

      <AutomationForm mode="create" />
    </div>
  );
}
