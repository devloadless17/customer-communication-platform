import { getSession } from "@/lib/current-user";

import { ChangePasswordForm } from "./change-password-form";

export const metadata = { title: "Account · Settings" };

export default async function AccountPage() {
  const { user } = await getSession();

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Account</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage your sign-in details. Other profile fields are coming soon.
        </p>
      </div>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="mb-4">
          <div className="text-sm font-medium">Profile</div>
          <div className="text-[11px] text-muted-foreground">Managed by your admin.</div>
        </div>
        <dl className="grid grid-cols-[120px_1fr] gap-y-2 text-sm">
          <dt className="text-muted-foreground">Name</dt>
          <dd>{user.name}</dd>
          <dt className="text-muted-foreground">Email</dt>
          <dd>{user.email}</dd>
          <dt className="text-muted-foreground">Role</dt>
          <dd className="capitalize">{user.role}</dd>
        </dl>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="mb-4">
          <div className="text-sm font-medium">Change password</div>
          <div className="text-[11px] text-muted-foreground">
            Use 8+ characters. Old sessions stay valid.
          </div>
        </div>
        <ChangePasswordForm />
      </section>
    </div>
  );
}
