"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Tag as TagIcon } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { ContactFieldDefinition } from "@ccp/shared/types";
import { CONVERSION_EVENT_NAMES } from "@ccp/shared/workflow-shapes";
import { FieldTokenPicker } from "@/features/templates/components/field-token-picker";
import { PhoneNumberInput } from "@/features/contacts/components/phone-number-input";
import { TokenHighlightTextarea } from "@/features/templates/components/token-highlight";

import { ConditionGroupEditor, ensureConditionIds } from "./condition-group";
import type { AskOptionEdgeOp } from "./graph-mutations";
import { OpenWindowContactCombobox } from "./open-window-contact-combobox";
import { type BuilderCatalogs, type Trigger, type WorkflowGraph, toGroup } from "./types";
import { TICKET_STATUS_LABELS, TICKET_STATUSES } from "@ccp/shared/tickets/types";

/**
 * Body editor wrapper: token-highlight textarea + insert-variable picker.
 *
 * Shared between send_message / add_comment / template-variable editors so
 * a single change to the picker styling propagates everywhere. The parent
 * owns the value (config.body or whatever); we just thread keystrokes back
 * out through onChange and splice token inserts at the live cursor.
 *
 * Tokens are stored verbatim in the saved config and resolved at run time
 * by `resolveFieldTokens` (see @ccp/shared/field-tokens). That's why the
 * server's step handler doesn't need to know about the picker.
 */
/**
 * Trigger → which workflow-context namespaces should the picker expose.
 * Centralised here so adding a new trigger doesn't require touching every
 * step editor — bump this lookup and every `BodyTokenEditor` reflects it.
 */
function workflowNamespacesForTrigger(trigger: Trigger): {
  includeMessage: boolean;
  includeConversation: boolean;
} {
  switch (trigger) {
    case "message_received":
      return { includeMessage: true, includeConversation: true };
    case "conversation_created":
    case "conversation_opened":
    case "conversation_closed":
    case "conversation_assigned":
    case "conversation_status_changed":
      return { includeMessage: false, includeConversation: true };
    case "manual_trigger":
      // Manual_trigger CAN carry a conversation but it's optional; expose
      // the tokens — they'll resolve to empty when fired without one, same
      // behavior as any optional snapshot.
      return { includeMessage: false, includeConversation: true };
    default:
      return { includeMessage: false, includeConversation: false };
  }
}

function BodyTokenEditor({
  value,
  onChange,
  fieldDefinitions,
  rows = 4,
  placeholder,
  includeAgent,
  hint,
  trigger,
}: {
  value: string;
  onChange: (next: string) => void;
  fieldDefinitions: ContactFieldDefinition[];
  rows?: number;
  placeholder?: string;
  includeAgent?: boolean;
  hint?: string;
  /** Workflow's trigger — drives which extra token namespaces are exposed. */
  trigger?: Trigger;
}) {
  const { includeMessage, includeConversation } = trigger
    ? workflowNamespacesForTrigger(trigger)
    : { includeMessage: false, includeConversation: false };
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const insert = useCallback(
    (token: string) => {
      const el = ref.current;
      if (!el) {
        onChange(value + token);
        return;
      }
      const start = el.selectionStart ?? value.length;
      const end = el.selectionEnd ?? value.length;
      const next = value.slice(0, start) + token + value.slice(end);
      onChange(next);
      requestAnimationFrame(() => {
        el.focus();
        const pos = start + token.length;
        el.setSelectionRange(pos, pos);
      });
    },
    [value, onChange],
  );
  return (
    <>
      <div className="flex justify-end">
        <FieldTokenPicker
          fieldDefinitions={fieldDefinitions}
          onInsert={insert}
          label="Insert variable"
          includeAgent={includeAgent}
          includeMessage={includeMessage}
          includeConversation={includeConversation}
          hint={hint}
        />
      </div>
      <TokenHighlightTextarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        placeholder={placeholder}
        fieldDefinitions={fieldDefinitions}
        includeAgent={includeAgent}
        includeMessage={includeMessage}
        includeConversation={includeConversation}
      />
    </>
  );
}

/**
 * Adapter — BuilderCatalogs.fields has just key+label; the picker + highlight
 * components want full ContactFieldDefinition. The other fields are unused by
 * both consumers so a thin cast is safe and avoids a refactor of the catalog
 * loader.
 */
function asFieldDefs(
  fields: BuilderCatalogs["fields"],
): ContactFieldDefinition[] {
  return fields as unknown as ContactFieldDefinition[];
}

// Step target — which contact / phone does this step act on? -------------------

/**
 * Wire shape for the step's `target` config field. Mirrors the server-side
 * StepTarget type in apps/api/src/lib/workflows/steps/target.ts. Keeping the
 * type duplicated here (instead of importing from @ccp/shared) because the
 * server side parses the raw JSON anyway; the web type is just a UI hint.
 */
export type StepTarget =
  | { kind: "trigger_contact" }
  | { kind: "phone"; phoneNumber: string }
  // DYNAMIC omnichannel: the PERSON behind the trigger contact, on their best
  // live channel (no id to configure — resolved at run time).
  | { kind: "trigger_customer" }
  // Person's best channel by static `Customer` id. Settable via the workflow
  // API / import; a customer-picker radio is a follow-up (mirrors the deferred
  // `kind:"contact"` picker). Listed so the type stays in sync with the server
  // and the editor preserves an imported customer target on save.
  | { kind: "customer"; customerId: string };

/**
 * Target selector — radio between "trigger contact" (default) and "custom
 * phone". When phone is picked, a single-line input collects the E.164
 * number. The server normalizes + validates on save, so a typo here
 * surfaces in the workflow's stepErrors block on save.
 *
 * `extraHint` is rendered below the phone input when set — used by
 * send_message to mention the 24h window caveat for cold reachout.
 */
function TargetSelector({
  target,
  onChange,
  extraHint,
  phoneMode = "window",
}: {
  target: StepTarget | undefined;
  onChange: (next: StepTarget | undefined) => void;
  extraHint?: string;
  /** "window" (default) — pick a contact inside the 24h window (send_message,
   *  free-form sends fail outside it). "free" — type any number with the
   *  +country picker (send_template; templates work cold/out-of-window). */
  phoneMode?: "window" | "free";
}) {
  const mode = target?.kind ?? "trigger_contact";
  const phone = target?.kind === "phone" ? target.phoneNumber : "";
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/20 p-3">
      <div className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
        Target
      </div>
      <label className="flex cursor-pointer items-center gap-2 text-sm">
        <input
          type="radio"
          name="target-mode"
          checked={mode === "trigger_contact"}
          onChange={() => onChange(undefined)}
          className="size-3.5"
        />
        <span>Contact from the trigger</span>
        <span className="text-2xs text-muted-foreground">(default)</span>
      </label>
      <label className="flex cursor-pointer items-start gap-2 text-sm">
        <input
          type="radio"
          name="target-mode"
          checked={mode === "trigger_customer"}
          onChange={() => onChange({ kind: "trigger_customer" })}
          className="mt-0.5 size-3.5"
        />
        <span className="flex flex-col">
          <span>The person&apos;s best channel</span>
          <span className="text-2xs text-muted-foreground">
            Reach the unified person behind the trigger on whichever channel is
            live (WhatsApp / Messenger / Instagram), not just the one they used.
          </span>
        </span>
      </label>
      <label className="flex cursor-pointer items-center gap-2 text-sm">
        <input
          type="radio"
          name="target-mode"
          checked={mode === "phone"}
          onChange={() =>
            onChange({ kind: "phone", phoneNumber: phone })
          }
          className="size-3.5"
        />
        <span>Custom phone number</span>
      </label>
      {mode === "phone" && (
        <div className="ml-6 flex flex-col gap-1">
          {phoneMode === "free" ? (
            <>
              <PhoneNumberInput
                value={phone}
                onChange={(e164) => onChange({ kind: "phone", phoneNumber: e164 })}
              />
              <span className="text-2xs text-muted-foreground">
                Any number — templates can reach contacts outside the 24h window.
              </span>
            </>
          ) : (
            <>
              <OpenWindowContactCombobox
                value={phone ? { phoneNumber: phone } : null}
                onChange={(next) =>
                  onChange(
                    next
                      ? { kind: "phone", phoneNumber: next.phoneNumber }
                      : { kind: "phone", phoneNumber: "" },
                  )
                }
              />
              <span className="text-2xs text-muted-foreground">
                Pick from contacts who messaged you in the last 24h. Cold reachout
                (outside the window) requires a Send Template step.
              </span>
            </>
          )}
          {extraHint && (
            <span className="text-2xs text-warning-fg">
              {extraHint}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Single-line variable input + an inline "Insert variable" button. Used for
 * Send Template variables where each `{{n}}` placeholder is a separate slot.
 * Splices the picked token at the input's caret position (same pattern as
 * the multiline body editor above).
 */
function TemplateVariableRow({
  idx,
  value,
  onChange,
  fieldDefinitions,
  trigger,
}: {
  idx: number;
  value: string;
  onChange: (next: string) => void;
  fieldDefinitions: ContactFieldDefinition[];
  trigger?: Trigger;
}) {
  const { includeMessage, includeConversation } = trigger
    ? workflowNamespacesForTrigger(trigger)
    : { includeMessage: false, includeConversation: false };
  const ref = useRef<HTMLInputElement | null>(null);
  const insert = useCallback(
    (token: string) => {
      const el = ref.current;
      if (!el) {
        onChange(value + token);
        return;
      }
      const start = el.selectionStart ?? value.length;
      const end = el.selectionEnd ?? value.length;
      const next = value.slice(0, start) + token + value.slice(end);
      onChange(next);
      requestAnimationFrame(() => {
        el.focus();
        const pos = start + token.length;
        el.setSelectionRange(pos, pos);
      });
    },
    [value, onChange],
  );
  return (
    <div className="flex items-center gap-2">
      <span className="w-12 shrink-0 font-mono text-xs text-muted-foreground">{`{{${idx + 1}}}`}</span>
      <Input ref={ref} value={value} onChange={(e) => onChange(e.target.value)} />
      <FieldTokenPicker
        fieldDefinitions={fieldDefinitions}
        onInsert={insert}
        label="Variable"
        includeMessage={includeMessage}
        includeConversation={includeConversation}
      />
    </div>
  );
}

/**
 * Per-step editors. Each editor takes the (typed) config + onChange + the
 * subset of catalogs it needs. Kept in one file because most are small
 * (10-50 lines) and the import noise of one-file-per-editor was outweighing
 * its readability.
 */

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-sm font-medium">{label}</label>
      {children}
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

// send_message --------------------------------------------------------------

export function SendMessageEditor({
  config,
  onChange,
  fields,
  channelAccounts,
  trigger,
}: {
  config: { body?: string; target?: StepTarget; accountId?: string };
  onChange: (c: Record<string, unknown>) => void;
  fields: BuilderCatalogs["fields"];
  channelAccounts: BuilderCatalogs["channelAccounts"];
  trigger: Trigger;
}) {
  return (
    <div className="flex flex-col gap-4">
      <Field
        label="Message"
        hint="Tokens like $var.contact.name resolve per contact. Outside the 24h window this step fails — use Send Template instead."
      >
        <BodyTokenEditor
          value={config.body ?? ""}
          onChange={(body) => onChange({ ...config, body })}
          fieldDefinitions={asFieldDefs(fields)}
          rows={4}
          placeholder="Hi $var.contact.name, thanks for reaching out!"
          hint="Contact tokens resolve against the selected target."
          trigger={trigger}
        />
      </Field>
      <TargetSelector
        target={config.target}
        onChange={(target) => onChange({ ...config, target })}
        extraHint="Free-form sends require the contact to have messaged you in the last 24h. For cold reachout, use a Send Template step."
      />
      {/* Sender identity. A reply always follows the thread — moving a live
          conversation to another number mid-flight would reach the customer
          from a sender they never messaged. The picker therefore governs only
          the case where this step OPENS a thread, and hides itself when there
          is nothing to choose between. */}
      <SendAccountPicker
        accounts={channelAccounts}
        value={config.accountId}
        onChange={(accountId) => onChange({ ...config, accountId })}
      />
    </div>
  );
}

/**
 * Which account a send-step OPENS a conversation on.
 *
 * Hidden entirely when the workspace has fewer than two accounts: there is
 * nothing to disambiguate, and the old copy ("a workflow that starts a
 * brand-new conversation uses the channel's default") was honest but described
 * a limitation rather than offering a choice.
 *
 * Deliberately does NOT govern replies. An existing thread always sends from
 * its own account — re-pointing a live conversation would reach the customer
 * from a number they never messaged, with no service window and an unknown
 * sender.
 */
function SendAccountPicker({
  accounts,
  value,
  onChange,
}: {
  accounts: BuilderCatalogs["channelAccounts"];
  value: string | undefined;
  onChange: (accountId: string | undefined) => void;
}) {
  if (accounts.length < 2) {
    return (
      <p className="text-2xs text-muted-foreground">
        Sends go out on the conversation&apos;s own number/account.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-medium">
        When this starts a new conversation, send from
      </label>
      <Select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || undefined)}
      >
        <option value="">The channel&apos;s default account</option>
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name} · {a.channel}
          </option>
        ))}
      </Select>
      <p className="text-2xs text-muted-foreground">
        Replies always go out on the conversation&apos;s own account — this only
        applies when the step opens a brand-new thread.
      </p>
    </div>
  );
}

// send_template -------------------------------------------------------------

function countPlaceholders(text: string): number {
  const found = new Set<number>();
  const re = /\{\{\s*(\d+)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) found.add(Number.parseInt(m[1]!, 10));
  return found.size;
}

export function SendTemplateEditor({
  config,
  onChange,
  templates,
  fields,
  channelAccounts,
  trigger,
}: {
  config: {
    templateId?: string;
    variables?: { body?: string[]; header?: string };
    target?: StepTarget;
    accountId?: string;
  };
  onChange: (c: Record<string, unknown>) => void;
  templates: BuilderCatalogs["templates"];
  fields: BuilderCatalogs["fields"];
  channelAccounts: BuilderCatalogs["channelAccounts"];
  trigger: Trigger;
}) {
  const approved = templates.filter((t) => t.status === "approved");
  const selected = templates.find((t) => t.id === config.templateId);
  const bodyVarCount = selected ? countPlaceholders(selected.bodyText) : 0;
  const bodyVars = config.variables?.body ?? [];

  function pickTemplate(id: string) {
    const t = templates.find((x) => x.id === id);
    if (!t) {
      onChange({ ...config, templateId: id, variables: { body: [] } });
      return;
    }
    const count = countPlaceholders(t.bodyText);
    const next = Array.from({ length: count }, (_, i) => bodyVars[i] ?? "");
    onChange({ ...config, templateId: id, variables: { body: next } });
  }

  function setVar(idx: number, val: string) {
    const next = bodyVars.slice();
    while (next.length <= idx) next.push("");
    next[idx] = val;
    onChange({ ...config, variables: { ...config.variables, body: next } });
  }

  return (
    <div className="flex flex-col gap-4">
      <Field
        label="Template"
        hint={
          approved.length === 0
            ? "No approved templates yet — submit one in Templates → New first."
            : "Only approved templates can be sent."
        }
      >
        <Select
          value={config.templateId ?? ""}
          onChange={(e) => pickTemplate(e.target.value)}
        >
          <option value="">Select a template…</option>
          {approved.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({t.language})
            </option>
          ))}
        </Select>
      </Field>
      {selected && (
        <div className="rounded-md border border-border bg-muted/30 p-3 text-xs">
          <div className="text-3xs font-medium uppercase tracking-wide text-muted-foreground">Preview</div>
          <pre className="mt-1 whitespace-pre-wrap font-sans text-sm">{selected.bodyText}</pre>
        </div>
      )}
      {bodyVarCount > 0 && (
        <Field label={`Variables (${bodyVarCount})`} hint="Plain text or $var.contact.* tokens resolved per run.">
          <div className="flex flex-col gap-2">
            {Array.from({ length: bodyVarCount }).map((_, i) => (
              <TemplateVariableRow
                key={i}
                idx={i}
                value={bodyVars[i] ?? ""}
                onChange={(v) => setVar(i, v)}
                fieldDefinitions={asFieldDefs(fields)}
                trigger={trigger}
              />
            ))}
          </div>
        </Field>
      )}
      <TargetSelector
        target={config.target}
        onChange={(target) => onChange({ ...config, target })}
        phoneMode="free"
      />
      {/* Especially load-bearing for templates: a template belongs to ONE
          WhatsApp Business Account, so a cold reachout opened on the wrong
          number is refused at send time with `template_wrong_account`. */}
      <SendAccountPicker
        accounts={channelAccounts}
        value={config.accountId}
        onChange={(accountId) => onChange({ ...config, accountId })}
      />
    </div>
  );
}

// add_comment --------------------------------------------------------------

export function AddCommentEditor({
  config,
  onChange,
  fields,
  trigger,
}: {
  config: { body?: string };
  onChange: (c: Record<string, unknown>) => void;
  fields: BuilderCatalogs["fields"];
  trigger: Trigger;
}) {
  return (
    <Field
      label="Note"
      hint="Internal — never sent to the contact. Tokens like $var.contact.name resolve per run."
    >
      <BodyTokenEditor
        value={config.body ?? ""}
        onChange={(body) => onChange({ body })}
        fieldDefinitions={asFieldDefs(fields)}
        rows={3}
        placeholder="Customer asking for $var.contact.email — needs invoice"
        trigger={trigger}
      />
    </Field>
  );
}

// assign_to ----------------------------------------------------------------

export function AssignToEditor({
  config,
  onChange,
  users,
  assignmentPolicies,
}: {
  config: {
    mode?: "user" | "unassign" | "round_robin" | "policy";
    userId?: string;
    policyId?: string;
    overwrite?: boolean;
  };
  onChange: (c: Record<string, unknown>) => void;
  users: BuilderCatalogs["users"];
  assignmentPolicies: BuilderCatalogs["assignmentPolicies"];
}) {
  // Both auto-route modes share the overwrite switch — it's the one decision
  // that changes whether the step can take a conversation away from the agent
  // already working it.
  const isAuto = config.mode === "round_robin" || config.mode === "policy";
  return (
    <Field label="Mode">
      <div className="flex flex-col gap-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="assign-mode"
            checked={config.mode === "user"}
            onChange={() => onChange({ mode: "user", userId: config.userId ?? users[0]?.id ?? "" })}
          />
          Assign to a teammate
        </label>
        {config.mode === "user" && (
          <Select
            value={config.userId ?? ""}
            onChange={(e) => onChange({ mode: "user", userId: e.target.value })}
            className="h-8 px-2 pr-7"
            wrapperClassName="ml-6"
          >
            <option value="">Select a user…</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({u.email})
              </option>
            ))}
          </Select>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="assign-mode"
            checked={config.mode === "round_robin"}
            onChange={() =>
              onChange({ mode: "round_robin", overwrite: config.overwrite ?? false })
            }
          />
          Auto-route (use the team&apos;s assignment rules)
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="assign-mode"
            checked={config.mode === "policy"}
            onChange={() =>
              onChange({
                mode: "policy",
                policyId:
                  config.policyId ??
                  assignmentPolicies.find((p) => p.isDefault)?.id ??
                  assignmentPolicies[0]?.id ??
                  "",
                overwrite: config.overwrite ?? false,
              })
            }
          />
          Auto-route with a specific policy
        </label>
        {config.mode === "policy" && (
          <Select
            value={config.policyId ?? ""}
            onChange={(e) =>
              onChange({
                mode: "policy",
                policyId: e.target.value,
                overwrite: config.overwrite ?? false,
              })
            }
            className="h-8 px-2 pr-7"
            wrapperClassName="ml-6"
          >
            <option value="">Select a policy…</option>
            {assignmentPolicies.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.isDefault ? " (default)" : ""}
              </option>
            ))}
          </Select>
        )}
        {isAuto && (
          <label className="ml-6 flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={config.overwrite === true}
              onChange={(e) => onChange({ ...config, overwrite: e.target.checked })}
            />
            <span>
              Reassign even if someone already has it
              <span className="mt-0.5 block text-xs text-muted-foreground">
                Off (recommended): the step only fills an empty assignee, so it
                can&apos;t take a conversation away from the agent working it. Turn
                it on for an escalation workflow whose whole purpose is to move
                the thread.
              </span>
            </span>
          </label>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="assign-mode"
            checked={config.mode === "unassign"}
            onChange={() => onChange({ mode: "unassign" })}
          />
          Unassign
        </label>
      </div>
    </Field>
  );
}

// set_status / open_conversation / close_conversation ----------------------

export function SetStatusEditor({
  config,
  onChange,
}: {
  config: { status?: "open" | "pending" | "closed" };
  onChange: (c: Record<string, unknown>) => void;
}) {
  return (
    <Field label="Target status">
      <Select
        value={config.status ?? "open"}
        onChange={(e) => onChange({ status: e.target.value })}
      >
        <option value="open">Open</option>
        <option value="pending">Pending</option>
        <option value="closed">Closed</option>
      </Select>
    </Field>
  );
}

export function OpenConversationEditor() {
  return (
    <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
      Opens the conversation. No further configuration.
    </div>
  );
}

export function CloseConversationEditor({
  config,
  onChange,
}: {
  config: { category?: string; summary?: string };
  onChange: (c: Record<string, unknown>) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <Field label="Category" hint="Optional. Shown in the inbox close-history.">
        <Input
          value={config.category ?? ""}
          onChange={(e) => onChange({ ...config, category: e.target.value })}
          placeholder="resolved / abandoned / spam"
        />
      </Field>
      <Field label="Summary" hint="Optional. Free-form note about what happened.">
        <Textarea
          value={config.summary ?? ""}
          onChange={(e) => onChange({ ...config, summary: e.target.value })}
          rows={3}
        />
      </Field>
    </div>
  );
}

// add_tag / remove_tag ------------------------------------------------------

export function TagEditor({
  config,
  onChange,
  tags,
  verb,
}: {
  config: { tagId?: string; target?: StepTarget };
  onChange: (c: Record<string, unknown>) => void;
  tags: BuilderCatalogs["tags"];
  verb: "Add" | "Remove";
}) {
  const selected = tags.find((t) => t.id === config.tagId);
  return (
    <div className="flex flex-col gap-4">
      <Field
        label="Tag"
        hint={tags.length === 0 ? "No tags yet — create them in Settings → Tags." : `${verb} this tag from the contact.`}
      >
        <div className="flex flex-col gap-2">
          <Select
            value={config.tagId ?? ""}
            onChange={(e) => onChange({ ...config, tagId: e.target.value })}
          >
            <option value="">Select a tag…</option>
            {tags.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
          {selected && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <TagIcon className="size-3.5" />
              <span className="inline-flex items-center rounded-full bg-primary/15 px-2 py-0.5 text-3xs font-medium text-primary">
                {selected.name}
              </span>
            </div>
          )}
        </div>
      </Field>
      <TargetSelector
        target={config.target}
        onChange={(target) => onChange({ ...config, target })}
      />
    </div>
  );
}

// update_field --------------------------------------------------------------

export function UpdateFieldEditor({
  config,
  onChange,
  fields,
}: {
  config: { fieldKey?: string; value?: string; target?: StepTarget };
  onChange: (c: Record<string, unknown>) => void;
  fields: BuilderCatalogs["fields"];
}) {
  const selectedField = fields.find((f) => f.key === config.fieldKey);
  const isSelect = selectedField?.type === "select";
  // A select field's stored value is the option ID; the dropdown writes ids.
  // "Custom value / token" keeps the raw input available (e.g. a $var token
  // that resolves to an option NAME at run time — the server resolves
  // name-or-id and rejects anything else with invalid_option).
  const options = selectedField?.options ?? [];
  const valueIsKnownOption =
    config.value === undefined ||
    config.value === "" ||
    options.some((o) => o.id === config.value);
  const [customValue, setCustomValue] = useState(isSelect && !valueIsKnownOption);
  return (
    <div className="flex flex-col gap-4">
      <Field label="Field" hint="The contact's custom fields. Add new ones in Settings → Contact Fields.">
        <Select
          value={config.fieldKey ?? ""}
          onChange={(e) => {
            setCustomValue(false);
            // Changing the field invalidates the old value (a text string or
            // another field's option id) — clear it so a stale id can't ride
            // along into the new field.
            onChange({ ...config, fieldKey: e.target.value, value: "" });
          }}
        >
          <option value="">Select a field…</option>
          {fields.map((f) => (
            <option key={f.key} value={f.key}>
              {f.label} ({f.key})
            </option>
          ))}
        </Select>
      </Field>
      {isSelect && !customValue ? (
        <Field
          label="Option"
          hint={
            <>
              The field&apos;s dropdown options.{" "}
              <button
                type="button"
                className="underline hover:text-foreground"
                onClick={() => setCustomValue(true)}
              >
                Use a custom value / token instead
              </button>
            </>
          }
        >
          <Select
            value={config.value ?? ""}
            onChange={(e) => onChange({ ...config, value: e.target.value })}
          >
            <option value="">Select an option…</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
        </Field>
      ) : (
        <Field
          label="Value"
          hint={
            isSelect ? (
              <>
                Must resolve to one of the field&apos;s options (name or id) at
                run time.{" "}
                <button
                  type="button"
                  className="underline hover:text-foreground"
                  onClick={() => {
                    setCustomValue(false);
                    if (!valueIsKnownOption) onChange({ ...config, value: "" });
                  }}
                >
                  Pick an option instead
                </button>
              </>
            ) : (
              "Tokens like $var.contact.email resolve per run."
            )
          }
        >
          <Input
            value={config.value ?? ""}
            onChange={(e) => onChange({ ...config, value: e.target.value })}
          />
        </Field>
      )}
      <TargetSelector
        target={config.target}
        onChange={(target) => onChange({ ...config, target })}
      />
    </div>
  );
}

// update_lifecycle ----------------------------------------------------------

export function UpdateLifecycleEditor({
  config,
  onChange,
  stages,
}: {
  config: { stageId?: string; target?: StepTarget };
  onChange: (c: Record<string, unknown>) => void;
  stages: BuilderCatalogs["stages"];
}) {
  return (
    <div className="flex flex-col gap-4">
      <Field label="Stage">
        <Select
          value={config.stageId ?? ""}
          onChange={(e) => onChange({ ...config, stageId: e.target.value })}
        >
          <option value="">Select a stage…</option>
          {stages.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      </Field>
      <TargetSelector
        target={config.target}
        onChange={(target) => onChange({ ...config, target })}
      />
    </div>
  );
}

// branch --------------------------------------------------------------------

/**
 * Wire shape for the Branch step's `preset` config field. Mirrors the
 * server-side BranchPreset type in apps/api/src/lib/workflows/branch-presets.ts.
 * Duplicated here (not imported) for the same reason as StepTarget — the
 * server parses the raw JSON anyway and we don't drag server-only modules
 * into the client bundle.
 */
export type BranchPreset =
  | { type: "window_open" }
  | { type: "has_tag"; tagId: string }
  | { type: "in_stage"; stageId: string }
  | { type: "field_equals"; fieldKey: string; value: string }
  | { type: "message_contains"; needle: string; caseSensitive?: boolean };

const BRANCH_PRESET_OPTIONS: Array<{
  type: BranchPreset["type"];
  label: string;
  description: string;
}> = [
  { type: "window_open", label: "Is 24h window open?", description: "true → contact messaged in the last 24h. Wire true to Send Message, false to Send Template." },
  { type: "has_tag", label: "Contact has tag", description: "true → contact carries the selected tag." },
  { type: "in_stage", label: "Contact in stage", description: "true → contact is in the selected lifecycle stage." },
  { type: "field_equals", label: "Custom field equals", description: "true → the contact's custom field matches the value." },
  { type: "message_contains", label: "Message contains text", description: "true → the triggering message body contains the substring (only for message_received)." },
];

export function BranchEditor({
  config,
  trigger,
  onChange,
  catalogs,
}: {
  config: { preset?: BranchPreset; conditions?: unknown };
  /** Workflow's trigger — scopes which condition fields are offered.
   *  Earlier this editor always set allowAllFields, which exposed fields
   *  like stage_from / stage_to ("Previous stage" / "New stage") that are
   *  only populated by the contact_lifecycle_updated trigger. On a
   *  message_received workflow those conditions silently never matched —
   *  users picked them and wondered why nothing fired. Scoping to the
   *  trigger removes the confusion (contact_stage_id stays available for
   *  every trigger because the runner reads it off the live contact row). */
  trigger: Trigger;
  onChange: (c: Record<string, unknown>) => void;
  catalogs: BuilderCatalogs;
}) {
  const mode: "preset" | "custom" = config.preset ? "preset" : "custom";
  const preset = config.preset;

  // Stamp stable client-only `_id` keys ONCE per conditions identity, not on
  // every render. ensureConditionIds mints fresh random ids for rows lacking
  // one, so calling it inline in the render body re-keyed every condition input
  // on any external re-render (autosave tick, sibling state) until the tree was
  // first edited — remounting the inputs and dropping the user's focus mid-type.
  // Memoizing on `config.conditions` (a stable reference between external
  // re-renders; only a real edit swaps it, and that value already carries _ids)
  // keeps the keys stable. persist() strips _id back out so the DB never sees them.
  const conditionGroup = useMemo(
    () => ensureConditionIds(toGroup(config.conditions)),
    [config.conditions],
  );

  function switchToPreset() {
    // Default to window_open — most-asked check.
    onChange({ ...config, preset: { type: "window_open" } });
  }
  function switchToCustom() {
    const next = { ...config };
    delete next.preset;
    onChange(next);
  }
  function setPreset(p: BranchPreset) {
    onChange({ ...config, preset: p });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="text-xs text-muted-foreground">
        Step routes to the <strong>true</strong> branch when the check passes,
        otherwise to <strong>false</strong>. Connect both edges in the canvas.
      </div>
      <div className="inline-flex w-fit items-center gap-0.5 rounded-md border border-border bg-muted/40 p-0.5 text-xs">
        <button
          type="button"
          onClick={switchToPreset}
          className={
            mode === "preset"
              ? "rounded px-2.5 py-1 font-medium bg-background text-foreground shadow-sm"
              : "rounded px-2.5 py-1 text-muted-foreground hover:text-foreground"
          }
        >
          Preset
        </button>
        <button
          type="button"
          onClick={switchToCustom}
          className={
            mode === "custom"
              ? "rounded px-2.5 py-1 font-medium bg-background text-foreground shadow-sm"
              : "rounded px-2.5 py-1 text-muted-foreground hover:text-foreground"
          }
        >
          Custom expression
        </button>
      </div>
      {mode === "preset" && preset && (
        <BranchPresetEditor
          preset={preset}
          onChange={setPreset}
          catalogs={catalogs}
          trigger={trigger}
        />
      )}
      {mode === "custom" && (
        <ConditionGroupEditor
          trigger={trigger}
          group={conditionGroup}
          onChange={(g) => onChange({ ...config, conditions: g })}
          catalogs={catalogs}
        />
      )}
    </div>
  );
}

function BranchPresetEditor({
  preset,
  onChange,
  catalogs,
  trigger,
}: {
  preset: BranchPreset;
  onChange: (p: BranchPreset) => void;
  catalogs: BuilderCatalogs;
  trigger: Trigger;
}) {
  const meta = BRANCH_PRESET_OPTIONS.find((o) => o.type === preset.type);
  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-muted/20 p-3">
      <Field label="Check">
        <Select
          value={preset.type}
          onChange={(e) => {
            const type = e.target.value as BranchPreset["type"];
            // Reset secondary fields when switching type so the saved config
            // never carries stale fields from another preset shape.
            onChange(emptyPreset(type));
          }}
        >
          {BRANCH_PRESET_OPTIONS.map((o) => (
            <option key={o.type} value={o.type}>
              {o.label}
            </option>
          ))}
        </Select>
        {meta && (
          <div className="text-xs text-muted-foreground">{meta.description}</div>
        )}
      </Field>
      {preset.type === "has_tag" && (
        <Field label="Tag">
          <Select
            value={preset.tagId}
            onChange={(e) => onChange({ type: "has_tag", tagId: e.target.value })}
          >
            <option value="">Select a tag…</option>
            {catalogs.tags.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {preset.type === "in_stage" && (
        <Field label="Stage">
          <Select
            value={preset.stageId}
            onChange={(e) => onChange({ type: "in_stage", stageId: e.target.value })}
          >
            <option value="">Select a stage…</option>
            {catalogs.stages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {preset.type === "field_equals" && (
        <>
          <Field label="Custom field">
            <Select
              value={preset.fieldKey}
              onChange={(e) =>
                // Changing the field invalidates the old comparison value (a
                // text string or another field's option id) — clear it.
                onChange({ ...preset, fieldKey: e.target.value, value: "" })
              }
            >
              <option value="">Select a field…</option>
              {catalogs.fields.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </Select>
          </Field>
          {(() => {
            // Select-type field: compare against an OPTION (the branch
            // evaluator matches the stored option ID — rename-stable, same
            // as in_stage storing a stageId). Text fields keep free input.
            const def = catalogs.fields.find((f) => f.key === preset.fieldKey);
            if (def?.type === "select") {
              return (
                <Field label="Equals option">
                  <Select
                    value={preset.value}
                    onChange={(e) => onChange({ ...preset, value: e.target.value })}
                  >
                    <option value="">Select an option…</option>
                    {(def.options ?? []).map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              );
            }
            return (
              <Field label="Equals">
                <Input
                  value={preset.value}
                  onChange={(e) => onChange({ ...preset, value: e.target.value })}
                  placeholder="VIP"
                />
              </Field>
            );
          })()}
        </>
      )}
      {preset.type === "message_contains" && (
        <>
          <Field
            label="Substring"
            hint={
              trigger === "message_received"
                ? undefined
                : "This trigger doesn't carry a message body — the check will always be false."
            }
          >
            <Input
              value={preset.needle}
              onChange={(e) => onChange({ ...preset, needle: e.target.value })}
              placeholder="refund"
            />
          </Field>
          <label className="flex cursor-pointer items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={preset.caseSensitive ?? false}
              onChange={(e) =>
                onChange({
                  ...preset,
                  ...(e.target.checked ? { caseSensitive: true } : { caseSensitive: undefined }),
                })
              }
              className="size-3.5"
            />
            <span>Case sensitive</span>
          </label>
        </>
      )}
    </div>
  );
}

function emptyPreset(type: BranchPreset["type"]): BranchPreset {
  switch (type) {
    case "window_open":
      return { type: "window_open" };
    case "has_tag":
      return { type: "has_tag", tagId: "" };
    case "in_stage":
      return { type: "in_stage", stageId: "" };
    case "field_equals":
      return { type: "field_equals", fieldKey: "", value: "" };
    case "message_contains":
      return { type: "message_contains", needle: "" };
  }
}

// wait ----------------------------------------------------------------------

export function WaitEditor({
  config,
  onChange,
}: {
  config: { delayMs?: number };
  onChange: (c: Record<string, unknown>) => void;
}) {
  const ms = config.delayMs ?? 60_000;
  // Pick a sensible default unit based on size of the current value.
  const initialUnit: "s" | "m" | "h" | "d" =
    ms >= 86_400_000 ? "d" : ms >= 3_600_000 ? "h" : ms >= 60_000 ? "m" : "s";

  const multipliers: Record<typeof initialUnit, number> = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };

  const value = Math.round(ms / multipliers[initialUnit]);

  return (
    <Field label="Duration" hint="The run pauses here. Resume is scheduled via BullMQ.">
      <div className="flex items-center gap-2">
        <Input
          type="number"
          min={1}
          value={value}
          onChange={(e) => {
            const n = Number.parseInt(e.target.value, 10);
            if (Number.isFinite(n) && n > 0) {
              onChange({ delayMs: n * multipliers[initialUnit] });
            }
          }}
          className="max-w-30"
        />
        <Select
          value={initialUnit}
          onChange={(e) => {
            const unit = e.target.value as typeof initialUnit;
            onChange({ delayMs: value * multipliers[unit] });
          }}
        >
          <option value="s">seconds</option>
          <option value="m">minutes</option>
          <option value="h">hours</option>
          <option value="d">days</option>
        </Select>
      </div>
    </Field>
  );
}

// jump_to_step --------------------------------------------------------------

export function JumpToStepEditor({
  config,
  onChange,
  graph,
  selfId,
}: {
  config: { targetStepId?: string; maxJumps?: number };
  onChange: (c: Record<string, unknown>) => void;
  graph: WorkflowGraph;
  selfId: string;
}) {
  const otherNodes = graph.nodes.filter((n) => n.id !== selfId);
  return (
    <div className="flex flex-col gap-4">
      <Field label="Target step">
        <Select
          value={config.targetStepId ?? ""}
          onChange={(e) => onChange({ ...config, targetStepId: e.target.value })}
        >
          <option value="">Select a step…</option>
          {otherNodes.map((n) => (
            <option key={n.id} value={n.id}>
              {n.id} ({n.type})
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Max jumps (optional)" hint="Per-run cap. The global ceiling is 100 steps regardless.">
        <Input
          type="number"
          min={1}
          value={config.maxJumps ?? ""}
          onChange={(e) => {
            const n = Number.parseInt(e.target.value, 10);
            onChange({
              ...config,
              maxJumps: Number.isFinite(n) && n > 0 ? n : undefined,
            });
          }}
          className="max-w-30"
        />
      </Field>
    </div>
  );
}

// ask_question -------------------------------------------------------------

/** Mirrors @ccp/shared/providers/types InteractiveOption — duplicated here
 *  for the same reason BranchPreset is. */
interface AskOption {
  id: string;
  title: string;
  description?: string;
}
type AnswerKind = "free_text" | "buttons" | "list" | "number" | "date";
interface AskQuestionSaveTo {
  kind: "custom_field";
  key: string;
}

export function AskQuestionEditor({
  config,
  onChange,
  onChangeWithEdges,
  fields,
  trigger,
}: {
  config: {
    question?: string;
    timeoutHours?: number;
    answerKind?: AnswerKind;
    options?: AskOption[];
    listCtaLabel?: string;
    /** Meta one-tap consent chips; buttons/list + social channels only. */
    contactShare?: Array<"phone" | "email">;
    numberMin?: number;
    numberMax?: number;
    saveTo?: AskQuestionSaveTo;
  };
  onChange: (c: Record<string, unknown>) => void;
  /** Config change that also reconciles the wired per-option graph edge —
   *  used when an option id is renamed (re-label the edge) or removed (drop
   *  it) so the child subtree isn't orphaned. */
  onChangeWithEdges: (c: Record<string, unknown>, edgeOp: AskOptionEdgeOp) => void;
  fields: BuilderCatalogs["fields"];
  trigger: Trigger;
}) {
  const hours = config.timeoutHours ?? 24;
  const answerKind: AnswerKind = config.answerKind ?? "free_text";
  const options = config.options ?? [];
  const maxOptions = answerKind === "buttons" ? 3 : 10;
  // Track the id an option had when its id field gained focus, so the wired
  // edge rename commits ONCE (oldId = focus-time id, newId = final id) rather
  // than per keystroke. Per-keystroke renaming meant a value typed transiently
  // through a sibling's id dropped/stole a wired edge. The commit fires on
  // blur, on Enter (which would otherwise submit the builder <form>), AND on a
  // short debounce after the last keystroke — a persist (autosave ~1.5s later
  // then a tab close, or the Enter submit) can beat the blur, and a graph
  // saved with the config id renamed but the edge label stale dangles the
  // edge (L92).
  const optionIdEditRef = useRef<{ idx: number; originalId: string } | null>(null);
  const optionIdCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirror the latest props so the debounced flush reads current values, not
  // the stale closure captured when its timer was scheduled a keystroke ago.
  const latestConfigRef = useRef(config);
  latestConfigRef.current = config;
  const onChangeWithEdgesRef = useRef(onChangeWithEdges);
  onChangeWithEdgesRef.current = onChangeWithEdges;
  useEffect(
    () => () => {
      if (optionIdCommitTimerRef.current) clearTimeout(optionIdCommitTimerRef.current);
    },
    [],
  );

  function changeAnswerKind(next: AnswerKind) {
    // Leaving buttons/list for a kind with NO per-option handles strands every
    // wired `opt_N` edge — route the config change through the graph-aware
    // callback so those edges are stripped in the SAME snapshot (mirrors how
    // removeOption drops a single edge). Detect by the CURRENT kind, not the
    // target: only buttons/list ever wire per-option edges.
    const leavingOptionKind =
      (answerKind === "buttons" || answerKind === "list") &&
      next !== "buttons" &&
      next !== "list";
    if (next === "free_text") {
      // `contactShare` rides the interactive send, so it must be dropped with the
      // other interactive-shape fields — the step's parseConfig rejects it on a
      // non-buttons/list kind, which would fail the publish rather than silently.
      const {
        options: _o,
        listCtaLabel: _l,
        contactShare: _cs,
        numberMin: _nmin,
        numberMax: _nmax,
        ...rest
      } = config;
      const nextConfig = { ...rest, answerKind: undefined };
      if (leavingOptionKind) {
        onChangeWithEdges(nextConfig, { kind: "remove_all_options", optionId: "" });
        return;
      }
      onChange(nextConfig);
      return;
    }
    if (next === "number" || next === "date") {
      // Drop interactive shape fields so a switch buttons → number doesn't
      // carry stale options (or consent chips) through.
      const { options: _o, listCtaLabel: _l, contactShare: _cs, ...rest } = config;
      const nextConfig = { ...rest, answerKind: next };
      if (leavingOptionKind) {
        onChangeWithEdges(nextConfig, { kind: "remove_all_options", optionId: "" });
        return;
      }
      onChange(nextConfig);
      return;
    }
    // Switching to a kind with a tighter cap: trim down so we don't carry
    // 10 list options into a 3-button mode.
    const cap = next === "buttons" ? 3 : 10;
    const nextOptions =
      options.length > 0 ? options.slice(0, cap) : [{ id: "yes", title: "Yes" }];
    const { numberMin: _nmin, numberMax: _nmax, ...rest } = config;
    onChange({ ...rest, answerKind: next, options: nextOptions });
  }

  function setOption(idx: number, patch: Partial<AskOption>) {
    const prev = options[idx]!;
    const next = [...options];
    next[idx] = { ...prev, ...patch };
    // When the option id changes, the wired per-option edge (labeled with the
    // OLD id) must follow — otherwise it dangles, orphaning the child subtree
    // and dead-ending the run. Route through the graph-aware callback so the
    // config + edge update apply to one snapshot. Title/description edits don't
    // touch edges, so they stay on the plain onChange path.
    if (patch.id !== undefined && patch.id !== prev.id) {
      onChangeWithEdges(
        { ...config, options: next },
        { kind: "rename", oldId: prev.id, newId: patch.id },
      );
      return;
    }
    onChange({ ...config, options: next });
  }
  function clearOptionIdCommitTimer() {
    if (optionIdCommitTimerRef.current) {
      clearTimeout(optionIdCommitTimerRef.current);
      optionIdCommitTimerRef.current = null;
    }
  }
  // Apply the pending wired-edge rename NOW (focus-time id -> current id) and
  // advance the anchor so a later flush is a no-op. Reads the LATEST config +
  // callback via refs so the debounced call (scheduled a keystroke ago) still
  // renames to the final id and against the current graph. See optionIdEditRef.
  function flushOptionIdRename() {
    clearOptionIdCommitTimer();
    const editing = optionIdEditRef.current;
    if (!editing) return;
    const finalId = latestConfigRef.current.options?.[editing.idx]?.id ?? "";
    if (finalId === editing.originalId) return;
    onChangeWithEdgesRef.current(
      { ...latestConfigRef.current },
      { kind: "rename", oldId: editing.originalId, newId: finalId },
    );
    optionIdEditRef.current = { idx: editing.idx, originalId: finalId };
  }
  // Per-keystroke draft of an option id: update config only (NO edge op). The
  // wired edge follows via flushOptionIdRename (blur / Enter / debounce).
  function setOptionIdDraft(idx: number, id: string) {
    const prev = options[idx];
    if (!prev) return;
    const next = [...options];
    next[idx] = { ...prev, id };
    onChange({ ...config, options: next });
    // Backstop the blur commit (L92): flush shortly after the last keystroke so
    // an autosave / tab-close that beats the blur persists an edge whose label
    // already matches the committed id.
    clearOptionIdCommitTimer();
    optionIdCommitTimerRef.current = setTimeout(flushOptionIdRename, 700);
  }
  function commitOptionId(idx: number) {
    const editing = optionIdEditRef.current;
    if (editing && editing.idx === idx) flushOptionIdRename();
    optionIdEditRef.current = null;
    clearOptionIdCommitTimer();
  }
  function addOption() {
    if (options.length >= maxOptions) return;
    // Unique id: `opt_N` keyed off a monotonic max over existing numeric
    // suffixes, not `options.length + 1` — the latter mints a duplicate after
    // a remove (e.g. delete opt_1 of [opt_1,opt_2] → length 1 → "opt_2" again),
    // which collides as both a React key and an edge label (L5).
    let maxN = 0;
    for (const o of options) {
      const m = /^opt_(\d+)$/.exec(o.id);
      if (m) maxN = Math.max(maxN, Number.parseInt(m[1]!, 10));
    }
    onChange({
      ...config,
      options: [...options, { id: `opt_${maxN + 1}`, title: "" }],
    });
  }
  function removeOption(idx: number) {
    const removed = options[idx]!;
    const next = options.filter((_, i) => i !== idx);
    // Drop the wired per-option edge for the removed id so it doesn't dangle
    // (orphaned child + phantom reappearing "+"). Mirror removeStep's edge
    // cleanup via the graph-aware callback.
    onChangeWithEdges({ ...config, options: next }, { kind: "remove", optionId: removed.id });
  }

  return (
    <div className="flex flex-col gap-4">
      <Field
        label="Question"
        hint="Sent to the trigger contact via WhatsApp. $var tokens resolve. The run pauses until they reply or the timeout expires."
      >
        <BodyTokenEditor
          value={config.question ?? ""}
          onChange={(question) => onChange({ ...config, question })}
          fieldDefinitions={asFieldDefs(fields)}
          rows={3}
          placeholder="Want to schedule a callback? Reply YES or NO."
          trigger={trigger}
        />
      </Field>

      <Field label="Answer type" hint="Buttons + list send a WhatsApp interactive message. Number / date validate the reply on resume — unparseable replies route to the timeout edge.">
        <div className="inline-flex w-fit flex-wrap items-center gap-0.5 rounded-md border border-border bg-muted/40 p-0.5 text-xs">
          {(["free_text", "buttons", "list", "number", "date"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => changeAnswerKind(k)}
              className={
                answerKind === k
                  ? "rounded px-2.5 py-1 font-medium bg-background text-foreground shadow-sm"
                  : "rounded px-2.5 py-1 text-muted-foreground hover:text-foreground"
              }
            >
              {k === "free_text"
                ? "Free text"
                : k === "buttons"
                  ? "Buttons"
                  : k === "list"
                    ? "List"
                    : k === "number"
                      ? "Number"
                      : "Date"}
            </button>
          ))}
        </div>
      </Field>

      {answerKind !== "free_text" && (
        <Field
          label={answerKind === "buttons" ? "Buttons (1-3)" : "List options (1-10)"}
          hint="Each option has an id (round-trips back as `$var.previousStep.optionId`) and a title (what the contact sees)."
        >
          <div className="flex flex-col gap-2">
            {options.map((opt, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <Input
                  value={opt.id}
                  onFocus={() => {
                    optionIdEditRef.current = { idx, originalId: opt.id };
                  }}
                  onChange={(e) => setOptionIdDraft(idx, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      // The builder root is a <form>; Enter here would submit
                      // (persist) before the blur commits the edge rename,
                      // saving a dangling edge (L92). Commit it and swallow the
                      // submit — autosave / exit-flush persists the reconciled
                      // graph.
                      e.preventDefault();
                      flushOptionIdRename();
                    }
                  }}
                  onBlur={() => commitOptionId(idx)}
                  placeholder="id"
                  className="max-w-25 font-mono text-xs"
                  aria-label={`Option ${idx + 1} id`}
                />
                <Input
                  value={opt.title}
                  onChange={(e) => setOption(idx, { title: e.target.value })}
                  placeholder={answerKind === "buttons" ? "Title (max 20)" : "Title (max 24)"}
                  maxLength={answerKind === "buttons" ? 20 : 24}
                  className="flex-1"
                  aria-label={`Option ${idx + 1} title`}
                />
                {answerKind === "list" && (
                  <Input
                    value={opt.description ?? ""}
                    onChange={(e) => setOption(idx, { description: e.target.value })}
                    placeholder="Description (optional)"
                    maxLength={72}
                    className="flex-1 text-xs"
                    aria-label={`Option ${idx + 1} description`}
                  />
                )}
                <button
                  type="button"
                  onClick={() => removeOption(idx)}
                  className="inline-flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive pointer-coarse:size-9"
                  aria-label={`Remove option ${idx + 1}`}
                >
                  ×
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={addOption}
              disabled={options.length >= maxOptions}
              className="inline-flex w-fit items-center gap-1 rounded-md border border-dashed border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
            >
              + Add option
            </button>
          </div>
        </Field>
      )}

      {answerKind === "list" && (
        <Field label="List CTA button label" hint="Shown on the button the contact taps to open the option sheet. Default: Choose.">
          <Input
            value={config.listCtaLabel ?? ""}
            onChange={(e) => onChange({ ...config, listCtaLabel: e.target.value || undefined })}
            placeholder="Choose"
            maxLength={20}
            className="max-w-50"
          />
        </Field>
      )}

      {(answerKind === "buttons" || answerKind === "list") && (
        <Field
          label="Also ask them to share (Messenger / Instagram only)"
          hint="Meta shows a one-tap chip pre-filled from the contact's profile (hidden if they haven't set it). This is the only way a social contact's phone or email can reach us — and the only way they auto-merge with their WhatsApp profile. WhatsApp has no such chip; the step routes to the timeout edge there."
        >
          <div className="flex items-center gap-4">
            {(["phone", "email"] as const).map((field) => {
              const selected = config.contactShare ?? [];
              const checked = selected.includes(field);
              return (
                <label key={field} className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => {
                      const next = e.target.checked
                        ? [...selected, field]
                        : selected.filter((f) => f !== field);
                      onChange({
                        ...config,
                        contactShare: next.length > 0 ? next : undefined,
                      });
                    }}
                  />
                  {field === "phone" ? "Phone number" : "Email address"}
                </label>
              );
            })}
          </div>
        </Field>
      )}

      {answerKind === "number" && (
        <Field label="Allowed range (optional)" hint="Inclusive min / max. Unparseable or out-of-range replies route to the timeout edge.">
          <div className="flex items-center gap-2">
            <Input
              type="number"
              value={config.numberMin ?? ""}
              onChange={(e) => {
                const n = Number.parseFloat(e.target.value);
                onChange({
                  ...config,
                  numberMin: Number.isFinite(n) ? n : undefined,
                });
              }}
              placeholder="min"
              className="max-w-30"
            />
            <span className="text-xs text-muted-foreground">—</span>
            <Input
              type="number"
              value={config.numberMax ?? ""}
              onChange={(e) => {
                const n = Number.parseFloat(e.target.value);
                onChange({
                  ...config,
                  numberMax: Number.isFinite(n) ? n : undefined,
                });
              }}
              placeholder="max"
              className="max-w-30"
            />
          </div>
        </Field>
      )}

      <Field label="Timeout (hours)" hint="If no reply within this window the workflow takes the 'timeout' edge.">
        <Input
          type="number"
          min={1}
          max={24 * 7}
          value={hours}
          onChange={(e) => {
            const n = Number.parseInt(e.target.value, 10);
            if (Number.isFinite(n) && n > 0) {
              onChange({ ...config, timeoutHours: n });
            }
          }}
          className="max-w-35"
        />
      </Field>

      <Field label="Save answer to field (optional)" hint="When the contact replies, write their answer to a contact custom field.">
        <Select
          value={config.saveTo?.key ?? ""}
          onChange={(e) => {
            const key = e.target.value;
            if (!key) {
              const { saveTo: _s, ...rest } = config;
              onChange(rest);
            } else {
              onChange({ ...config, saveTo: { kind: "custom_field", key } });
            }
          }}
          wrapperClassName="max-w-xs"
        >
          <option value="">— Don&apos;t save</option>
          {fields.map((f) => (
            <option key={f.key} value={f.key}>
              {f.label}
            </option>
          ))}
        </Select>
      </Field>

      <div className="rounded-md border border-dashed border-border bg-muted/20 px-3 py-2 text-2xs text-muted-foreground">
        {answerKind === "free_text" ? (
          <>
            Downstream steps read the answer via{" "}
            <code className="rounded bg-muted px-1 font-mono">$var.previousStep.answer</code>.
            Pair with a Branch (preset: message contains) to route on specific
            replies.
          </>
        ) : (
          <>
            Downstream steps see the tapped option id via{" "}
            <code className="rounded bg-muted px-1 font-mono">$var.previousStep.optionId</code>.
            Route with a Branch (preset: message contains) on the id you chose.
          </>
        )}
      </div>
    </div>
  );
}

// noop ---------------------------------------------------------------------

export function NoopEditor() {
  return (
    <div className="rounded-md border border-dashed border-border bg-muted/20 px-3 py-4 text-xs text-muted-foreground">
      This step does nothing. Useful as an explicit terminator for a branch
      path (e.g. <span className="font-mono">false</span> → Do Nothing) so the
      canvas doesn&apos;t read like an unfinished workflow.
    </div>
  );
}

// http_request --------------------------------------------------------------

export function HttpRequestEditor({
  config,
  onChange,
}: {
  config: {
    url?: string;
    bearerToken?: string;
    bearerTokenSet?: boolean;
    customHeaders?: Record<string, string>;
    timeoutMs?: number;
  };
  onChange: (c: Record<string, unknown>) => void;
}) {
  const tokenSet = config.bearerTokenSet === true;

  function headersToText(h?: Record<string, string>): string {
    if (!h) return "";
    return Object.entries(h).map(([k, v]) => `${k}: ${v}`).join("\n");
  }

  function parseHeaders(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const idx = trimmed.indexOf(":");
      if (idx === -1) continue;
      const k = trimmed.slice(0, idx).trim();
      const v = trimmed.slice(idx + 1).trim();
      if (k) out[k] = v;
    }
    return out;
  }

  return (
    <div className="flex flex-col gap-4">
      <Field label="URL" hint="HTTPS preferred. $var.contact.* tokens resolve per run.">
        <Input
          value={config.url ?? ""}
          onChange={(e) => onChange({ ...config, url: e.target.value })}
          placeholder="https://api.example.com/webhook"
          required
        />
      </Field>
      <Field
        label="Bearer token (optional)"
        hint={tokenSet ? "Token saved. Leave blank to keep, or enter a new value to overwrite." : ""}
      >
        <Input
          type="password"
          value={config.bearerToken ?? ""}
          onChange={(e) => onChange({ ...config, bearerToken: e.target.value })}
          placeholder={tokenSet ? "•••••••• (saved)" : ""}
        />
      </Field>
      <Field
        label="Custom headers (optional)"
        hint="One per line: Header-Name: value. Saved values are encrypted; a header shown as “•••••••• (saved)” keeps its stored value unless you overwrite it."
      >
        <Textarea
          value={headersToText(config.customHeaders)}
          onChange={(e) => {
            const parsed = parseHeaders(e.target.value);
            onChange({
              ...config,
              customHeaders: Object.keys(parsed).length > 0 ? parsed : undefined,
            });
          }}
          rows={3}
        />
      </Field>
      <Field label="Timeout (ms, optional, max 60000)">
        <Input
          type="number"
          value={config.timeoutMs?.toString() ?? ""}
          onChange={(e) => {
            const n = Number.parseInt(e.target.value, 10);
            onChange({
              ...config,
              timeoutMs: Number.isFinite(n) && n > 0 ? n : undefined,
            });
          }}
          placeholder="8000"
          min={1}
          max={60_000}
        />
      </Field>
    </div>
  );
}

// send_conversions_event -----------------------------------------------------

/** Mirrors CONVERSION_EVENT_NAMES validation server-side (parseConfig rejects
 *  anything outside the shared list). */
export function SendConversionsEventEditor({
  config,
  onChange,
}: {
  config: {
    eventName?: string;
    currency?: string;
    value?: number;
    testEventCode?: string;
  };
  onChange: (c: Record<string, unknown>) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <Field label="Conversion event">
        <Select
          value={config.eventName ?? "Purchase"}
          onChange={(e) => onChange({ ...config, eventName: e.target.value })}
          wrapperClassName="max-w-xs"
        >
          {CONVERSION_EVENT_NAMES.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </Select>
      </Field>
      <div className="flex gap-3">
        <Field label="Value (optional)" hint="Set currency and value together, or neither.">
          <Input
            type="number"
            value={config.value?.toString() ?? ""}
            onChange={(e) => {
              const n = Number.parseFloat(e.target.value);
              onChange({
                ...config,
                value: Number.isFinite(n) && n >= 0 ? n : undefined,
              });
            }}
            placeholder="123"
            min={0}
            step="any"
          />
        </Field>
        <Field label="Currency (optional)">
          <Input
            value={config.currency ?? ""}
            onChange={(e) =>
              onChange({ ...config, currency: e.target.value.toUpperCase() || undefined })
            }
            placeholder="USD"
            maxLength={3}
            className="w-24"
          />
        </Field>
      </div>
      <Field
        label="Test event code (optional)"
        hint="Routes the event to Events Manager's Test Events tab to verify the plumbing. Meta still uses these events for delivery — it is not a sandbox."
      >
        <Input
          value={config.testEventCode ?? ""}
          onChange={(e) =>
            onChange({ ...config, testEventCode: e.target.value || undefined })
          }
          placeholder="TEST12345"
          className="max-w-xs"
        />
      </Field>
      <div className="rounded-md border border-dashed border-border bg-muted/20 px-3 py-2 text-2xs text-muted-foreground">
        Sends a conversion signal to Meta Ads for the ad this contact came
        from. WhatsApp/Messenger sends power purchase optimization;
        Instagram is measurement-only for now. Contacts without an ad click
        are skipped — the workflow continues.
      </div>
    </div>
  );
}

// trigger_workflow ----------------------------------------------------------

export function TriggerWorkflowEditor({
  config,
  onChange,
  workflows,
}: {
  config: { workflowId?: string };
  onChange: (c: Record<string, unknown>) => void;
  workflows: BuilderCatalogs["workflows"];
}) {
  const eligible = workflows.filter((w) => w.trigger === "manual_trigger");
  return (
    <Field
      label="Workflow"
      hint={
        eligible.length === 0
          ? "No manual_trigger workflows yet — create one first."
          : "Only workflows with trigger = manual_trigger can be invoked from another workflow."
      }
    >
      <Select
        value={config.workflowId ?? ""}
        onChange={(e) => onChange({ workflowId: e.target.value })}
      >
        <option value="">Select a workflow…</option>
        {eligible.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
      </Select>
    </Field>
  );
}


// Tickets --------------------------------------------------------------------
//
// All four ticket steps act on the conversation's ACTIVE ticket. None offers a
// ticket picker, deliberately: a workflow runs in the context of one
// conversation, and naming an arbitrary ticket would let it reach into work on
// a different thread.

export function CreateTicketEditor({
  config,
  onChange,
}: {
  config: { subject?: string; priority?: string; onlyIfNoActiveTicket?: boolean };
  onChange: (c: Record<string, unknown>) => void;
}) {
  return (
    <>
      <Field label="Subject" hint="Optional. Leave empty to fall back to the contact's name.">
        <Input
          value={config.subject ?? ""}
          maxLength={200}
          placeholder="e.g. Refund request"
          onChange={(e) => onChange({ ...config, subject: e.target.value })}
        />
      </Field>
      <Field label="Priority">
        <Select
          value={config.priority ?? "normal"}
          onChange={(e) => onChange({ ...config, priority: e.target.value })}
        >
          <option value="low">Low</option>
          <option value="normal">Normal</option>
          <option value="high">High</option>
          <option value="urgent">Urgent</option>
        </Select>
      </Field>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={config.onlyIfNoActiveTicket !== false}
          onChange={(e) => onChange({ ...config, onlyIfNoActiveTicket: e.target.checked })}
        />
        <span>
          Skip if the conversation already has an open ticket
          <span className="block text-xs text-muted-foreground">
            On by default. Without it, a workflow that runs on every inbound message
            mints a new ticket each time the customer writes.
          </span>
        </span>
      </label>
    </>
  );
}

export function SetTicketStatusEditor({
  config,
  onChange,
}: {
  config: { status?: string; resolutionCode?: string };
  onChange: (c: Record<string, unknown>) => void;
}) {
  const status = config.status ?? "solved";
  return (
    <>
      <Field
        label="Target status"
        hint="Applies to the conversation's active ticket. If there is none, the step is skipped and the workflow continues."
      >
        <Select value={status} onChange={(e) => onChange({ ...config, status: e.target.value })}>
          {TICKET_STATUSES.map((st) => (
            <option key={st} value={st}>
              {TICKET_STATUS_LABELS[st]}
            </option>
          ))}
        </Select>
      </Field>
      {(status === "solved" || status === "closed") && (
        <Field label="Resolution code" hint="Optional. A short, reportable outcome — “refunded”, “duplicate”.">
          <Input
            value={config.resolutionCode ?? ""}
            maxLength={80}
            placeholder="e.g. auto_resolved"
            onChange={(e) => onChange({ ...config, resolutionCode: e.target.value })}
          />
        </Field>
      )}
    </>
  );
}

export function SetTicketPriorityEditor({
  config,
  onChange,
}: {
  config: { priority?: string };
  onChange: (c: Record<string, unknown>) => void;
}) {
  return (
    <Field
      label="Priority"
      hint="Changing priority restarts the SLA clock from now under the new priority's promise — that is what escalating means."
    >
      <Select
        value={config.priority ?? "high"}
        onChange={(e) => onChange({ priority: e.target.value })}
      >
        <option value="low">Low</option>
        <option value="normal">Normal</option>
        <option value="high">High</option>
        <option value="urgent">Urgent</option>
      </Select>
    </Field>
  );
}

export function AssignTicketEditor({
  config,
  onChange,
  users,
  policies,
}: {
  config: {
    mode?: "user" | "team" | "unassign";
    userId?: string;
    policyId?: string | null;
    overwrite?: boolean;
  };
  onChange: (c: Record<string, unknown>) => void;
  users: BuilderCatalogs["users"];
  /** Teams (Team) available for queue routing. */
  policies?: Array<{ id: string; name: string }>;
}) {
  return (
    <Field label="Mode">
      <div className="flex flex-col gap-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="assign-ticket-mode"
            checked={config.mode === "user"}
            onChange={() =>
              onChange({ mode: "user", userId: config.userId ?? users[0]?.id ?? "" })
            }
          />
          Assign to a teammate
        </label>
        {config.mode === "user" && (
          <>
            <Select
              value={config.userId ?? ""}
              onChange={(e) => onChange({ ...config, mode: "user", userId: e.target.value })}
              className="h-8 px-2 pr-7"
              wrapperClassName="ml-6"
            >
              <option value="">Select a user…</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </Select>
            <label className="ml-6 flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={config.overwrite === true}
                onChange={(e) => onChange({ ...config, overwrite: e.target.checked })}
              />
              <span>
                Reassign even if someone already owns it
                <span className="block text-xs text-muted-foreground">
                  Off by default: automation fills an empty slot, it never takes work
                  away from the person doing it.
                </span>
              </span>
            </label>
          </>
        )}
        {/* Queue routing: the SAME engine that routes conversations (weights,
            capacity, working hours, continuity), applied to the ticket. Without
            it a team queue was only a label — nothing ever picked a person out
            of it. */}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="assign-ticket-mode"
            checked={config.mode === "team"}
            onChange={() => onChange({ mode: "team", policyId: config.policyId ?? null })}
          />
          Route to a team
        </label>
        {config.mode === "team" && (
          <>
            <Select
              value={config.policyId ?? ""}
              onChange={(e) =>
                onChange({ ...config, mode: "team", policyId: e.target.value || null })
              }
              className="h-8 px-2 pr-7"
              wrapperClassName="ml-6"
            >
              <option value="">Let the routing rules decide</option>
              {(policies ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
            <p className="ml-6 text-xs text-muted-foreground">
              Picks whoever on that team is available and has capacity, using your
              assignment settings. If nobody is eligible the ticket stays in the queue
              rather than going to someone who is off-shift.
            </p>
            <label className="ml-6 flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={config.overwrite === true}
                onChange={(e) => onChange({ ...config, overwrite: e.target.checked })}
              />
              <span>Reassign even if someone already owns it</span>
            </label>
          </>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="assign-ticket-mode"
            checked={config.mode === "unassign"}
            onChange={() => onChange({ mode: "unassign" })}
          />
          Unassign
        </label>
      </div>
    </Field>
  );
}
