import { redirect } from "next/navigation";

import { EmptyStateCreateChannel } from "@/features/team-chat/components/empty-state-create-channel";
import { getSession } from "@/lib/auth/current-user";
import { getDefaultChannel } from "@/lib/api/queries";

export const metadata = {
  title: "Team Chat",
};

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

  return (
    <div className="flex h-[calc(100svh-3rem)] flex-col items-center justify-center gap-3 text-center md:h-svh">
      <h1 className="text-lg font-semibold">No channels yet</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        Create the first channel to get your team chatting — the default{" "}
        <code>#general</code> usually gets created automatically when the team
        is provisioned.
      </p>
      {/* No role branch: anyone can create a public channel now, so there's
          no "ask an admin" dead end. */}
      <EmptyStateCreateChannel currentRole={user.role} />
    </div>
  );
}
