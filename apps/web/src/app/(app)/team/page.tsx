import { redirect } from "next/navigation";

import { EmptyStateCreateChannel } from "@/features/team-chat/components/empty-state-create-channel";
import { getSession } from "@/lib/auth/current-user";
import { getDefaultChannel } from "@/lib/api/queries";
import { canCreateChannel } from "@ccp/shared/team-chat/permissions";

/**
 * /team — bounce to the team's default channel (the auto-created #general).
 * If somehow no channels exist (default got deleted at the DB level), we
 * render a small empty-state. Viewers who can create a channel get a primary
 * "Create channel" CTA (the same flow the sidebar `+` opens); everyone else
 * gets the "ask an admin" copy.
 */
export default async function TeamIndexPage() {
  const channel = await getDefaultChannel();
  if (channel) {
    redirect(`/team/${channel.id}`);
  }

  const { user } = await getSession();
  const canCreate = canCreateChannel(user.role);

  return (
    <div className="flex h-[calc(100svh-3rem)] flex-col items-center justify-center gap-3 text-center md:h-svh">
      <h1 className="text-lg font-semibold">No channels yet</h1>
      {canCreate ? (
        <>
          <p className="max-w-md text-sm text-muted-foreground">
            Create the first channel to get your team chatting — the default{" "}
            <code>#general</code> usually gets created automatically when the
            team is provisioned.
          </p>
          <EmptyStateCreateChannel />
        </>
      ) : (
        <p className="max-w-md text-sm text-muted-foreground">
          Ask an admin to create the first channel — the default{" "}
          <code>#general</code> usually gets created automatically when the team
          is provisioned.
        </p>
      )}
    </div>
  );
}
