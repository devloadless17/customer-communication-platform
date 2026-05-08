"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Trash2, X } from "lucide-react";

import {
  AddFieldRow,
  prettifyKey,
  uniquePerContactKey,
} from "@/components/contacts/field-controls";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type {
  Contact,
  ContactFieldDefinition,
  ContactListItem,
} from "@/lib/types";

/**
 * Modal for manually creating a contact. Used for outbound-first scenarios
 * (e.g. before a customer has messaged us — required for the upcoming
 * template-send flow). Phone is required; everything else optional.
 *
 * Custom fields can be added inline:
 *  - **Per-contact** extras stay local until the contact is created and ride
 *    along in the same POST — no extra round trips.
 *  - **Team-wide** definitions hit `/api/team/contact-fields` immediately
 *    because they outlive this dialog. The new definition is bubbled up so
 *    the parent page sees it (filter chips, future opens of the dialog).
 *
 * Built as a portal-free fixed overlay because we don't have a Radix Dialog
 * primitive in the project yet and adding one for one screen isn't worth
 * the dep weight.
 */
export function NewContactDialog({
  fieldDefinitions,
  canManageFields,
  onClose,
  onCreated,
  onTeamWideFieldAdded,
}: {
  fieldDefinitions: ContactFieldDefinition[];
  canManageFields: boolean;
  onClose: () => void;
  onCreated: (item: ContactListItem) => void;
  /** Called when the user adds a team-wide definition mid-dialog so the
   *  parent can splice it into its own list. */
  onTeamWideFieldAdded: (def: ContactFieldDefinition) => void;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [location, setLocation] = useState("");
  const [customValues, setCustomValues] = useState<Record<string, string>>({});
  // Per-contact one-off keys added via the "+ Add field" button. Tracked
  // separately from team-wide defs so we can render them with prettyfied
  // labels and offer a delete button.
  const [perContactKeys, setPerContactKeys] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const phoneRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    phoneRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit() {
    setError(null);
    if (!phone.trim()) {
      setError("Phone number is required");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/contacts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          phoneNumber: phone,
          name: name || undefined,
          email: email || undefined,
          location: location || undefined,
          // Drop empty fields server-side anyway, but cleaner to send only
          // what was set.
          customFields: Object.fromEntries(
            Object.entries(customValues).filter(([, v]) => v.trim().length > 0),
          ),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "Couldn't create contact");
        return;
      }
      const data = (await res.json()) as { contact: Contact };
      onCreated({
        contact: data.contact,
        activeConversationId: null,
        lastMessageAt: null,
        // A freshly-created contact has never messaged us, so the 24h
        // window is not open. The list-row chip will render "No window".
        lastInboundAt: null,
      });
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  // All keys currently in play — used so a per-contact label can't slug to a
  // key that conflicts with a team-wide def or another per-contact extra.
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
      aria-labelledby="new-contact-title"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-16"
      onClick={(e) => {
        // Backdrop click closes — but ignore clicks bubbling out of the panel.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-lg border border-border bg-card text-card-foreground shadow-lg">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 id="new-contact-title" className="text-base font-semibold">
            New contact
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
          <Field label="Phone number" required>
            <Input
              ref={phoneRef}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+1 555 555 0100"
              required
              className="font-mono"
            />
          </Field>
          <Field label="Name">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Defaults to phone number"
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
                          setCustomValues((prev) => {
                            const next = { ...prev };
                            delete next[key];
                            return next;
                          });
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
            <Button type="submit" disabled={submitting || !phone.trim()}>
              {submitting && <Loader2 className="size-3.5 animate-spin" />}
              Create contact
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
