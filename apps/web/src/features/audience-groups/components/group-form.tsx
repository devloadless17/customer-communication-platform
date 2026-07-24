"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useSoftRefresh } from "@/hooks/use-soft-refresh";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, Loader2, Save, Send, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  AudienceBuilder,
  type AudienceValue,
} from "@/features/broadcasts/components/audience-builder";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { apiFetch } from "@/lib/api/client-fetch";
import { apiErrorMessage } from "@ccp/shared/api/error-message";
import { toast } from "@/lib/toast";
import type { ContactLabel } from "@/features/contacts/components/contact-select-dialog";
import type { ContactFieldDefinition, ContactStage, Tag } from "@ccp/shared/types";
import type { AudienceGroupDto } from "@ccp/shared/dtos";

/**
 * Create / edit an audience group. The audience itself — tag membership ∪
 * hand-picked contacts, with a live count + preview — is the shared
 * {@link AudienceBuilder}, the same control the broadcast wizard uses for a
 * one-off audience. This form only adds the bits unique to a *saved* group:
 * a name, a description, and the save/delete/send actions.
 */

export interface GroupFormProps {
  /** When set, the form starts in "edit" mode pre-filled from this dto. */
  initial?: AudienceGroupDto;
  tags: Tag[];
  fieldDefinitions?: ContactFieldDefinition[];
  stages?: ContactStage[];
  /** Server-provided labels for the group's existing manual contacts. */
  initialContactLabels?: ContactLabel[];
}

export function GroupForm({
  initial,
  tags,
  fieldDefinitions = [],
  stages = [],
  initialContactLabels = [],
}: GroupFormProps) {
  const router = useRouter();
  const softRefresh = useSoftRefresh();
  const { confirm, confirmDialog } = useConfirm();

  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [audience, setAudience] = useState<AudienceValue>({
    tagIds: initial?.tagIds ?? [],
    contactIds: initial?.contactIds ?? [],
  });
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Unsaved-changes guard for the "Send broadcast" shortcut — that link jumps
  // to the broadcast wizard which reads the *saved* group, so edits made here
  // but not saved would be silently ignored.
  const dirty = initial
    ? name.trim() !== initial.name ||
      (description.trim() || "") !== (initial.description ?? "") ||
      [...audience.tagIds].sort().join(",") !== [...(initial.tagIds ?? [])].sort().join(",") ||
      [...audience.contactIds].sort().join(",") !==
        [...(initial.contactIds ?? [])].sort().join(",")
    : false;

  async function submit(redirectTo = "/broadcasts/groups") {
    setError(null);
    if (!name.trim()) {
      setError("Group name is required");
      return;
    }
    setSubmitting(true);
    try {
      const body = {
        name: name.trim(),
        description: description.trim() || null,
        tagIds: audience.tagIds,
        contactIds: audience.contactIds,
      };
      const res = initial
        ? await apiFetch(`/api/workspace/audience-groups/${initial.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          })
        : await apiFetch("/api/workspace/audience-groups", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
          detail?: string;
        };
        setError(
          [data.error, data.detail].filter(Boolean).join(": ") || `HTTP ${res.status}`,
        );
        return;
      }
      toast.success(initial ? `Saved "${name.trim()}"` : `Created "${name.trim()}"`);
      router.push(redirectTo);
      softRefresh();
    } finally {
      setSubmitting(false);
    }
  }

  async function goToBroadcast() {
    if (!initial || submitting || deleting) return;
    const target = `/broadcasts/new?groupId=${initial.id}`;
    if (dirty) {
      const ok = await confirm({
        title: "Unsaved changes",
        description:
          "You have unsaved changes to this group. Save them before starting the broadcast?",
        confirmLabel: "Save & continue",
        cancelLabel: "Stay here",
      });
      if (ok) void submit(target);
      return;
    }
    router.push(target);
  }

  async function deleteGroup() {
    if (!initial) return;
    const ok = await confirm({
      title: `Delete group "${initial.name}"?`,
      description:
        "Past broadcasts that used it stay in your history. This can't be undone.",
      confirmLabel: "Delete group",
      destructive: true,
    });
    if (!ok) return;
    setDeleting(true);
    try {
      const res = await apiFetch(`/api/workspace/audience-groups/${initial.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        // `HTTP 409` told the user nothing; the helper prefers the API's own
        // sentence and falls back to a humanized key.
        setError(await apiErrorMessage(res, `Couldn't delete the group.`));
        return;
      }
      toast.success(`Deleted "${initial.name}"`);
      router.push("/broadcasts/groups");
      softRefresh();
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-8">
      <header className="flex flex-col gap-2">
        <Link
          href="/broadcasts/groups"
          className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Back to groups
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">
          {initial ? "Edit group" : "New audience group"}
        </h1>
        <p className="text-sm text-muted-foreground">
          A reusable list of contacts you can broadcast to in one click. Mix
          tag-based membership (dynamic) with hand-picked contacts (manual) —
          the group is the union of both at send time.
        </p>
      </header>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              Name <span className="text-destructive">*</span>
            </span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Ramadan customers, Important customers"
              maxLength={80}
              autoFocus
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              Description <span className="text-muted-foreground">(optional)</span>
            </span>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Anything that helps you remember who this group is for."
              rows={2}
              maxLength={500}
            />
          </label>
        </div>
      </section>

      <AudienceBuilder
        value={audience}
        onChange={setAudience}
        tags={tags}
        fieldDefinitions={fieldDefinitions}
        stages={stages}
        initialContactLabels={initialContactLabels}
        initialCount={initial?.memberCount ?? 0}
        noun="member"
        contactDialogTitle="Add contacts to this group"
      />

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="wrap-break-word">{error}</span>
        </div>
      )}

      <div className="sticky bottom-0 -mx-6 border-t border-border bg-background/95 px-6 py-3 backdrop-blur">
        <div className="flex items-center gap-2">
          {initial && (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={deleteGroup}
                disabled={deleting || submitting}
                className="gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                {deleting ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Trash2 className="size-3.5" />
                )}
                Delete group
              </Button>
              <button
                type="button"
                onClick={goToBroadcast}
                disabled={submitting || deleting}
                className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
                title={
                  dirty
                    ? "You have unsaved changes — you'll be asked to save them first"
                    : "Start a broadcast with this group as the audience"
                }
              >
                <Send className="size-3.5" />
                Send broadcast
                {dirty && <span className="ml-1 text-3xs text-warning-fg">• unsaved</span>}
              </button>
            </>
          )}
          <div className="ml-auto flex items-center gap-2">
            <Link
              href="/broadcasts/groups"
              className="inline-flex h-9 cursor-pointer items-center rounded-md px-4 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              Cancel
            </Link>
            <Button
              type="button"
              onClick={() => submit()}
              disabled={submitting || !name.trim()}
              className="gap-1.5"
            >
              {submitting ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Save className="size-3.5" />
              )}
              {initial ? "Save changes" : "Create group"}
            </Button>
          </div>
        </div>
      </div>

      {confirmDialog}
    </div>
  );
}
