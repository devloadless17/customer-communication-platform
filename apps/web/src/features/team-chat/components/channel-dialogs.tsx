"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { fetchWithSessionGuard } from "@/lib/auth/client-session-guard";
import { toast } from "@/lib/toast";
import {
  isValidChannelName,
  normalizeChannelName,
  type TeamChannelDto,
} from "@ccp/shared/team-chat/types";

/**
 * Minimal modal dialogs for create + edit + delete channel. Wraps the shared
 * <Dialog> primitive (canonical scrim + card chrome + scroll-lock + focus-trap
 * + Escape) so this surface matches every other modal without a Radix dep.
 */

function ModalShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <Dialog open onClose={onClose}>
      <DialogContent className="max-w-md p-5" ariaLabel={title}>
        <div className="mb-3 text-base font-semibold">{title}</div>
        {children}
      </DialogContent>
    </Dialog>
  );
}

export function NewChannelDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (channel: TeamChannelDto) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const normalized = normalizeChannelName(name);
  const isValid = isValidChannelName(normalized);

  const submit = async () => {
    if (!isValid) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetchWithSessionGuard("/api/team/channels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: normalized, description }),
      });
      const json = (await res.json()) as { channel?: TeamChannelDto; error?: string; detail?: string };
      if (!res.ok || !json.channel) {
        setError(json.detail ?? json.error ?? "Failed to create channel.");
        return;
      }
      onCreated(json.channel);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell title="Create channel" onClose={onClose}>
      <div className="space-y-3">
        <div>
          <label className="text-xs font-medium text-muted-foreground">Name</label>
          <Input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            placeholder="sales"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
          />
          <div className="mt-1 text-2xs text-muted-foreground">
            Becomes <span className="font-mono">#{normalized || "channel-name"}</span> ·
            lowercase letters, digits, and dashes.
          </div>
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground">Description (optional)</label>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="What's this channel about?"
          />
        </div>
        {error && <div className="text-xs text-destructive">{error}</div>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!isValid || busy}>
            Create channel
          </Button>
        </div>
      </div>
    </ModalShell>
  );
}

export function EditChannelDialog({
  channel,
  onClose,
  onUpdated,
}: {
  channel: TeamChannelDto;
  onClose: () => void;
  onUpdated: (channel: TeamChannelDto) => void;
}) {
  const [name, setName] = useState(channel.name);
  const [description, setDescription] = useState(channel.description ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const normalized = normalizeChannelName(name);
  const isValid = isValidChannelName(normalized);

  const submit = async () => {
    if (!isValid) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetchWithSessionGuard(`/api/team/channels/${channel.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: normalized, description }),
      });
      const json = (await res.json()) as { channel?: TeamChannelDto; error?: string; detail?: string };
      if (!res.ok || !json.channel) {
        setError(json.detail ?? json.error ?? "Failed to update channel.");
        return;
      }
      onUpdated(json.channel);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell title={`Edit #${channel.name}`} onClose={onClose}>
      <div className="space-y-3">
        <div>
          <label className="text-xs font-medium text-muted-foreground">Name</label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={channel.isDefault}
          />
          {channel.isDefault && (
            <div className="mt-1 text-2xs text-muted-foreground">
              The default channel can't be renamed.
            </div>
          )}
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground">Description</label>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
          />
        </div>
        {error && <div className="text-xs text-destructive">{error}</div>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!isValid || busy}>
            Save changes
          </Button>
        </div>
      </div>
    </ModalShell>
  );
}

export function useDeleteChannel() {
  const router = useRouter();
  const { confirm, confirmDialog } = useConfirm();
  const deleteChannel = async (channelId: string, fallbackHref: string) => {
    const ok = await confirm({
      title: "Delete this channel?",
      description: "All its messages will be lost. This can't be undone.",
      confirmLabel: "Delete channel",
      destructive: true,
    });
    if (!ok) return;
    const res = await fetchWithSessionGuard(`/api/team/channels/${channelId}`, {
      method: "DELETE",
    });
    if (res.ok) {
      toast.success("Channel deleted");
      router.push(fallbackHref);
    } else {
      const json = (await res.json().catch(() => ({}))) as { detail?: string; error?: string };
      toast.error("Couldn't delete channel", {
        description: json.detail ?? json.error ?? `HTTP ${res.status}`,
      });
    }
  };
  return { deleteChannel, confirmDialog };
}
