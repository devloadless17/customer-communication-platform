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
  RESERVED_CHANNEL_NAMES,
  type TeamChannelDto,
} from "@ccp/shared/team-chat/types";
import { canCreateChannel, canManageChannel } from "@ccp/shared/team-chat/permissions";
import { cn } from "@ccp/shared/utils";
import type { Role } from "@ccp/shared/types";

/**
 * Minimal modal dialogs for create + edit + delete channel. Wraps the shared
 * <Dialog> primitive (canonical scrim + card chrome + scroll-lock + focus-trap
 * + Escape) so this surface matches every other modal without a Radix dep.
 */

/**
 * Explain WHY a channel name is invalid, in the user's terms.
 *
 * `isValidChannelName` already encodes every rule; this just maps a failure
 * back to the specific reason so the form can say "Reserved name" instead of
 * silently disabling the button. Returns null when the name is fine (or still
 * empty — don't scold someone who hasn't typed yet).
 */
function describeChannelNameProblem(raw: string, normalized: string): string | null {
  if (!raw.trim()) return null;
  if (!normalized) return "Use at least one letter or digit.";
  if (isValidChannelName(normalized)) return null;
  if (RESERVED_CHANNEL_NAMES.has(normalized)) {
    return `"${normalized}" is a reserved name — pick another.`;
  }
  if (normalized.includes("--")) return "No double dashes.";
  if (normalized.length > 32) return "Keep it to 32 characters or fewer.";
  return "Lowercase letters, digits, and single dashes only.";
}

function VisibilityOption({
  checked,
  onSelect,
  disabled,
  label,
  hint,
}: {
  checked: boolean;
  onSelect: () => void;
  disabled?: boolean;
  label: string;
  hint: string;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer gap-2 rounded-md border p-2 transition-colors",
        checked ? "border-primary bg-primary/5" : "border-border hover:bg-accent",
        disabled && "cursor-not-allowed opacity-60 hover:bg-transparent",
      )}
    >
      <input
        type="radio"
        name="channel-visibility"
        className="mt-0.5"
        checked={checked}
        disabled={disabled}
        onChange={onSelect}
      />
      <span className="min-w-0">
        <span className="block text-xs font-medium">{label}</span>
        <span className="block text-2xs text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
}

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
  currentRole,
  onClose,
  onCreated,
}: {
  currentRole: Role;
  onClose: () => void;
  onCreated: (channel: TeamChannelDto) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const normalized = normalizeChannelName(name);
  const isValid = isValidChannelName(normalized);
  const nameProblem = describeChannelNameProblem(name, normalized);
  // Private channels stay admin/manager-gated: they're invisible in the
  // browser and excluded from everyone else's search, so an ungoverned one
  // has no discovery surface. Public creation is open to everyone.
  const mayCreatePrivate = canCreateChannel(currentRole, "private");

  const submit = async () => {
    if (!isValid) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetchWithSessionGuard("/api/workspace/channels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: normalized, description, visibility }),
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
            aria-invalid={nameProblem ? true : undefined}
            aria-describedby="new-channel-name-hint"
          />
          {/* Say WHY it's rejected. A disabled button with no explanation is
              the single most common "the app is broken" report. */}
          <div
            id="new-channel-name-hint"
            className={cn(
              "mt-1 text-2xs",
              nameProblem ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {nameProblem ?? (
              <>
                Becomes <span className="font-mono">#{normalized || "channel-name"}</span>{" "}
                · lowercase letters, digits, and dashes.
              </>
            )}
          </div>
        </div>

        <fieldset>
          <legend className="text-xs font-medium text-muted-foreground">
            Visibility
          </legend>
          <div className="mt-1 space-y-1.5">
            <VisibilityOption
              checked={visibility === "public"}
              onSelect={() => setVisibility("public")}
              label="Public"
              hint="Anyone on the team can find and join this channel."
            />
            <VisibilityOption
              checked={visibility === "private"}
              onSelect={() => setVisibility("private")}
              disabled={!mayCreatePrivate}
              label="Private"
              hint={
                mayCreatePrivate
                  ? "Invite only. Won't appear in Browse channels or others' search."
                  : "Only admins and managers can create private channels."
              }
            />
          </div>
        </fieldset>

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
  currentRole,
  onClose,
  onUpdated,
}: {
  channel: TeamChannelDto;
  currentRole: Role;
  onClose: () => void;
  onUpdated: (channel: TeamChannelDto) => void;
}) {
  // `?? ""` is safe here: only channels are editable — the service rejects
  // an edit targeting a DM (the only rows with a null name) with a 404.
  const [name, setName] = useState(channel.name ?? "");
  const [description, setDescription] = useState(channel.description ?? "");
  const [visibility, setVisibility] = useState(channel.visibility);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const normalized = normalizeChannelName(name);
  const isValid = isValidChannelName(normalized);
  const nameProblem = describeChannelNameProblem(name, normalized);
  // #general must stay public — it's the one channel every member is
  // guaranteed to be able to read. The server enforces this too.
  const mayChangeVisibility = canManageChannel(currentRole) && !channel.isDefault;

  const submit = async () => {
    if (!isValid) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetchWithSessionGuard(`/api/workspace/channels/${channel.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: normalized,
          description,
          ...(mayChangeVisibility ? { visibility } : {}),
        }),
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
    <ModalShell title={`Edit #${channel.name ?? ""}`} onClose={onClose}>
      <div className="space-y-3">
        <div>
          <label className="text-xs font-medium text-muted-foreground">Name</label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={channel.isDefault}
          />
          {channel.isDefault ? (
            <div className="mt-1 text-2xs text-muted-foreground">
              The default channel can&apos;t be renamed.
            </div>
          ) : nameProblem ? (
            <div className="mt-1 text-2xs text-destructive">{nameProblem}</div>
          ) : null}
        </div>

        {mayChangeVisibility && (
          <fieldset>
            <legend className="text-xs font-medium text-muted-foreground">
              Visibility
            </legend>
            <div className="mt-1 space-y-1.5">
              <VisibilityOption
                checked={visibility === "public"}
                onSelect={() => setVisibility("public")}
                label="Public"
                hint="Anyone on the team can find and join this channel."
              />
              <VisibilityOption
                checked={visibility === "private"}
                onSelect={() => setVisibility("private")}
                label="Private"
                hint="Invite only. Existing members keep their access."
              />
            </div>
          </fieldset>
        )}

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
    const res = await fetchWithSessionGuard(`/api/workspace/channels/${channelId}`, {
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
