"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Trash2, X } from "lucide-react";

import {
  AddFieldRow,
  prettifyKey,
  uniquePerContactKey,
} from "@/features/contacts/components/field-controls";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type {
  Contact,
  ContactFieldDefinition,
} from "@ccp/shared/types";
import { formatPhone } from "@ccp/shared/utils";

/**
 * Edit-contact dialog. Mirrors NewContactDialog's look but:
 *   - Phone is read-only (it's the WhatsApp identity used to dedupe
 *     inbound webhooks; the server PATCH rejects phoneNumber edits anyway).
 *   - Submits PATCH /api/contacts/[id] instead of POST.
 *   - Pre-fills every field from the existing contact.
 *
 * customFields here use partial-merge semantics on the server:
 *   - keys with a non-empty string overwrite
 *   - keys cleared by the user → sent as `null` so the server unsets them
 *   - keys never touched are not sent
 */
export function EditContactDialog({
  contact,
  fieldDefinitions,
  canManageFields,
  onClose,
  onSaved,
  onTeamWideFieldAdded,
}: {
  contact: Contact;
  fieldDefinitions: ContactFieldDefinition[];
  canManageFields: boolean;
  onClose: () => void;
  onSaved: (contact: Contact) => void;
  onTeamWideFieldAdded: (def: ContactFieldDefinition) => void;
}) {
  const [name, setName] = useState(contact.name);
  const [email, setEmail] = useState(contact.email ?? "");
  const [location, setLocation] = useState(contact.location ?? "");
  const [customValues, setCustomValues] = useState<Record<string, string>>(
    () => ({ ...contact.customFields }),
  );
  // Per-contact one-off keys (custom fields on this contact that aren't part
  // of the team-wide schema). Detected from the existing customFields bag —
  // anything not in fieldDefinitions is a one-off and we want to render it
  // with a delete affordance.
  const [perContactKeys, setPerContactKeys] = useState<string[]>(() => {
    const defKeys = new Set(fieldDefinitions.map((d) => d.key));
    return Object.keys(contact.customFields).filter((k) => !defKeys.has(k));
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
    nameRef.current?.select();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit() {
    setError(null);
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Name can't be empty");
      return;
    }

    // Diff against the original so we only PATCH what's changed. Helps the
    // server's "partial merge" customFields semantics stay accurate.
    const patch: Record<string, unknown> = {};
    if (trimmedName !== contact.name) patch.name = trimmedName;
    if (email.trim() !== (contact.email ?? "")) {
      patch.email = email.trim() === "" ? null : email.trim();
    }
    if (location.trim() !== (contact.location ?? "")) {
      patch.location = location.trim() === "" ? null : location.trim();
    }
    const customFieldsPatch: Record<string, string | null> = {};
    const allKeys = new Set([
      ...Object.keys(contact.customFields),
      ...Object.keys(customValues),
      ...perContactKeys,
    ]);
    for (const k of allKeys) {
      const before = contact.customFields[k] ?? "";
      const after = (customValues[k] ?? "").trim();
      if (before === after) continue;
      customFieldsPatch[k] = after === "" ? null : after;
    }
    if (Object.keys(customFieldsPatch).length > 0) {
      patch.customFields = customFieldsPatch;
    }

    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`/api/contacts/${contact.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "Couldn't save contact");
        return;
      }
      const data = (await res.json()) as { contact: Contact };
      onSaved(data.contact);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  function usedKeys(): Set<string> {
    return new Set([
      ...fieldDefinitions.map((d) => d.key),
      ...perContactKeys,
    ]);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-contact-title"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-16"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-lg border border-border bg-card text-card-foreground shadow-lg">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 id="edit-contact-title" className="text-base font-semibold">
            Edit contact
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="space-y-3 p-4"
        >
          <Field label="Phone number">
            <Input
              value={formatPhone(contact.phoneNumber)}
              disabled
              readOnly
              className="cursor-not-allowed font-mono opacity-70"
            />
            <p className="mt-1 text-[10px] text-muted-foreground">
              The phone number is the WhatsApp identity and can&apos;t be changed.
            </p>
          </Field>
          <Field label="Name" required>
            <Input
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </Field>
          <Field label="Email">
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="—"
            />
          </Field>
          <Field label="Location">
            <Input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="—"
            />
          </Field>

          {(fieldDefinitions.length > 0 || perContactKeys.length > 0) && (
            <div className="border-t border-border pt-3">
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Custom fields
              </div>
              <div className="space-y-2">
                {fieldDefinitions.map((def) => (
                  <Field key={def.id} label={def.label}>
                    <Input
                      value={customValues[def.key] ?? ""}
                      onChange={(e) =>
                        setCustomValues((prev) => ({
                          ...prev,
                          [def.key]: e.target.value,
                        }))
                      }
                      placeholder="—"
                    />
                  </Field>
                ))}

                {perContactKeys.map((key) => (
                  <Field key={key} label={prettifyKey(key)}>
                    <div className="flex items-center gap-1">
                      <Input
                        value={customValues[key] ?? ""}
                        onChange={(e) =>
                          setCustomValues((prev) => ({
                            ...prev,
                            [key]: e.target.value,
                          }))
                        }
                        placeholder="—"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          setPerContactKeys((prev) => prev.filter((k) => k !== key));
                          // Clearing to empty marks for removal at submit time.
                          setCustomValues((prev) => ({ ...prev, [key]: "" }));
                        }}
                        aria-label={`Remove ${prettifyKey(key)}`}
                        className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-destructive"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  </Field>
                ))}
              </div>
            </div>
          )}

          <AddFieldRow
            canManageFields={canManageFields}
            onAddPerContact={async (label) => {
              const key = uniquePerContactKey(label, usedKeys());
              setPerContactKeys((prev) => [...prev, key]);
              setCustomValues((prev) => ({ ...prev, [key]: "" }));
            }}
            onAddTeamWide={async (label) => {
              const res = await fetch("/api/team/contact-fields", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ label }),
              });
              if (!res.ok) {
                const body = (await res.json().catch(() => ({}))) as { error?: string };
                setError(body.error ?? "Couldn't add field");
                return false;
              }
              const { definition } = (await res.json()) as {
                definition: ContactFieldDefinition;
              };
              onTeamWideFieldAdded(definition);
              return true;
            }}
          />

          {error && (
            <div className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || !name.trim()}>
              {submitting && <Loader2 className="size-3.5 animate-spin" />}
              Save changes
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 inline-block text-xs font-medium text-muted-foreground">
        {label}
        {required && <span className="ml-0.5 text-destructive">*</span>}
      </span>
      {children}
    </label>
  );
}
