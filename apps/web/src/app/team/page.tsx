import { redirect } from "next/navigation";

import { getDefaultChannel } from "@/lib/api/queries";

/**
 * /team — bounce to the team's default channel (the auto-created #general).
 * If somehow no channels exist (default got deleted at the DB level), we
 * render a small empty-state pointing the admin at the create-channel flow.
 */
export default async function TeamIndexPage() {
  const channel = await getDefaultChannel();
  if (channel) {
    redirect(`/team/${channel.id}`);
  }

  return (
    <div className="flex h-svh flex-col items-center justify-center gap-3 text-center">
      <h1 className="text-lg font-semibold">No channels yet</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        Ask an admin to create the first channel — the default <code>#general</code>{" "}
        usually gets created automatically when the team is provisioned.
      </p>
    </div>
  );
}
