"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Hash } from "lucide-react";

import { Button } from "@/components/ui/button";
import { fetchWithSessionGuard } from "@/lib/auth/client-session-guard";
import { toast } from "@/lib/toast";
import type { TeamChannelBrowseItemDto } from "@ccp/shared/team-chat/types";

/**
 * Shown when someone opens a PUBLIC channel's URL without being a member.
 *
 * This is the necessary counterpart to join-to-read: because
 * `requireChannelMembership` 404s non-members (deliberately unbranched on
 * visibility), every browse → link → paste path would otherwise dead-end on a
 * "not found" page for a channel that is, in fact, open to them.
 *
 * Only reachable for public channels — the preview endpoint returns null for
 * private channels and DMs, so those still 404 exactly as before.
 */
export function JoinChannelCard({
  channel,
}: {
  channel: TeamChannelBrowseItemDto;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const join = async () => {
    setBusy(true);
    try {
      const res = await fetchWithSessionGuard(
        `/api/team/channels/${channel.id}/join`,
        { method: "POST" },
      );
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { detail?: string };
        toast.error(json.detail ?? "Couldn't join that channel.");
        return;
      }
      // Full refresh rather than router.refresh(): the workspace must mount
      // fresh so its `subscribe:channel` runs with the membership row now
      // committed, otherwise the gateway silently drops the subscribe and the
      // feed receives no live messages.
      window.location.reload();
    } catch {
      toast.error("Couldn't join that channel.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-[calc(100svh-3rem)] flex-col items-center justify-center gap-3 px-6 text-center md:h-svh">
      <div className="flex size-12 items-center justify-center rounded-full bg-muted">
        <Hash className="size-6 text-muted-foreground" />
      </div>
      <h1 className="text-lg font-semibold">#{channel.name}</h1>
      {channel.description && (
        <p className="max-w-md text-sm text-muted-foreground">{channel.description}</p>
      )}
      <p className="text-xs text-muted-foreground">
        {channel.memberCount} {channel.memberCount === 1 ? "member" : "members"} · Public
        channel
      </p>
      <p className="max-w-md text-sm text-muted-foreground">
        Join this channel to read the conversation and post messages.
      </p>
      <div className="flex gap-2">
        <Button variant="ghost" onClick={() => router.push("/team")}>
          Back to team chat
        </Button>
        <Button onClick={() => void join()} disabled={busy}>
          {busy ? "Joining…" : "Join channel"}
        </Button>
      </div>
    </div>
  );
}
