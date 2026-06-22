import { getSession } from "@/lib/auth/current-user";
import { PageHeader } from "@/components/layouts/page-header";

import { ChangePasswordForm } from "./change-password-form";
import { ProfileForm } from "./profile-form";

export const metadata = { title: "Account · Settings" };

export default async function AccountPage() {
  const { user } = await getSession();

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Account"
        description="Update your name, avatar, and password. Email and role are managed by your admin."
      />

      <section className="rounded-xl border border-border bg-muted/20 p-5">
        <div className="mb-4">
          <div className="text-sm font-medium">Profile</div>
          <div className="text-2xs text-muted-foreground">
            How teammates see you in chat, assignments, and message attribution.
          </div>
        </div>
        <ProfileForm
          user={{
            id: user.id,
            teamId: user.teamId,
            name: user.name,
            email: user.email,
            avatarUrl: user.avatarUrl ?? null,
          }}
        />
      </section>

      <section className="rounded-xl border border-border bg-muted/20 p-5">
        <div className="mb-4">
          <div className="text-sm font-medium">Change password</div>
          <div className="text-2xs text-muted-foreground">
            Use 8+ characters. Old sessions stay valid.
          </div>
        </div>
        <ChangePasswordForm />
      </section>

      <section className="rounded-xl border border-border bg-muted/20 p-5">
        <div className="mb-4">
          <div className="text-sm font-medium">Email + role</div>
          <div className="text-2xs text-muted-foreground">
            Managed by your admin. Contact them to change either.
          </div>
        </div>
        <dl className="grid grid-cols-[120px_1fr] gap-y-2 text-sm">
          <dt className="text-muted-foreground">Email</dt>
          <dd>{user.email}</dd>
          <dt className="text-muted-foreground">Role</dt>
          <dd className="capitalize">{user.role}</dd>
        </dl>
      </section>
    </div>
  );
}
