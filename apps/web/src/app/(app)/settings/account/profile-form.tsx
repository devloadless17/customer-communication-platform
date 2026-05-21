"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Camera, Check, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { initials } from "@ccp/shared/utils";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api/client-fetch";
import { dispatchLocalSocketEvent } from "@/lib/socket-client";

interface ProfileFormProps {
  user: {
    id: string;
    teamId: string;
    name: string;
    email: string;
    avatarUrl: string | null;
  };
}

/**
 * Self-profile editor: name + avatar. Sits inline on /settings/account; the
 * password form is a sibling section. Saves go through PATCH /api/users/me
 * (name) and POST /api/users/me/avatar (image upload) — both publish
 * `user.profile_updated` server-side. We also dispatch a local socket frame
 * so this tab updates instantly without waiting for the round-trip echo,
 * matching the optimistic-socket-dispatch pattern used elsewhere.
 */
export function ProfileForm({ user }: ProfileFormProps) {
  const router = useRouter();
  const [name, setName] = useState(user.name);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(user.avatarUrl);
  const [savingName, startNameSave] = useTransition();
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<"name" | "avatar" | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const nameChanged = name.trim().length > 0 && name.trim() !== user.name;

  const onSaveName = () => {
    setError(null);
    setDone(null);
    const next = name.trim();
    if (!next || next === user.name) return;
    startNameSave(async () => {
      const res = await apiFetch("/api/users/me", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: next }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "Couldn't update name");
        return;
      }
      setDone("name");
      dispatchLocalSocketEvent("user:profile:updated", {
        teamId: user.teamId,
        userId: user.id,
        name: next,
      });
      // Server name changes don't bust the RSC cache automatically — refresh
      // so the header pill (which reads `getSession`) shows the new name.
      router.refresh();
    });
  };

  const onPickFile = () => {
    fileInputRef.current?.click();
  };

  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    e.target.value = "";
    if (!file) return;
    setError(null);
    setDone(null);

    if (file.size > 2 * 1024 * 1024) {
      setError("Avatar must be 2 MiB or smaller.");
      return;
    }
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      setError("Avatar must be a PNG, JPG, or WEBP image.");
      return;
    }

    setUploadingAvatar(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await apiFetch("/api/users/me/avatar", {
        method: "POST",
        body: fd,
      });
      const data = (await res.json().catch(() => ({}))) as {
        url?: string;
        error?: string;
        detail?: string;
      };
      if (!res.ok || !data.url) {
        setError(data.detail ?? data.error ?? "Couldn't upload avatar");
        return;
      }
      setAvatarUrl(data.url);
      setDone("avatar");
      dispatchLocalSocketEvent("user:profile:updated", {
        teamId: user.teamId,
        userId: user.id,
        avatarUrl: data.url,
      });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't upload avatar");
    } finally {
      setUploadingAvatar(false);
    }
  };

  const onClearAvatar = async () => {
    setError(null);
    setDone(null);
    setUploadingAvatar(true);
    try {
      const res = await apiFetch("/api/users/me", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ avatarUrl: null }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "Couldn't remove avatar");
        return;
      }
      setAvatarUrl(null);
      setDone("avatar");
      dispatchLocalSocketEvent("user:profile:updated", {
        teamId: user.teamId,
        userId: user.id,
        avatarUrl: null,
      });
      router.refresh();
      toast.success("Avatar removed");
    } finally {
      setUploadingAvatar(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-4">
        <div className="relative">
          <Avatar className="size-20">
            {avatarUrl ? <AvatarImage src={avatarUrl} alt={user.name} /> : null}
            <AvatarFallback seed={user.id} className="text-base">
              {initials(name || user.name)}
            </AvatarFallback>
          </Avatar>
          <button
            type="button"
            onClick={onPickFile}
            disabled={uploadingAvatar}
            aria-label="Upload new avatar"
            className="absolute -bottom-1 -right-1 inline-flex size-7 items-center justify-center rounded-full border border-border bg-card text-foreground shadow-sm transition-colors hover:bg-accent disabled:opacity-50"
          >
            {uploadingAvatar ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Camera className="size-3.5" />
            )}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            hidden
            onChange={onFileChange}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="text-sm font-medium">{user.name}</div>
          <div className="text-[11px] text-muted-foreground">
            PNG, JPG, or WEBP. Up to 2 MiB.
          </div>
          {avatarUrl ? (
            <button
              type="button"
              onClick={onClearAvatar}
              disabled={uploadingAvatar}
              className="inline-flex w-fit items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50"
            >
              <Trash2 className="size-3" />
              Remove
            </button>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="profile-name" className="text-xs font-medium text-muted-foreground">
          Display name
        </label>
        <div className="flex items-center gap-2">
          <Input
            id="profile-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            className="max-w-sm"
          />
          <Button
            type="button"
            onClick={onSaveName}
            disabled={!nameChanged || savingName}
            size="sm"
          >
            {savingName ? <Loader2 className="size-4 animate-spin" /> : null}
            Save
          </Button>
        </div>
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {error}
        </div>
      ) : null}
      {done ? (
        <div className="flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-primary">
          <Check className="size-3.5" />
          {done === "name" ? "Name updated." : "Avatar updated."}
        </div>
      ) : null}
    </div>
  );
}
