// Note: no `server-only` import — runs inside the BullMQ workflow worker,
// outside the Next bundler context (same as the other step helpers).

import { db } from "@/lib/db";
import { loadSelectFieldDisplayDefs } from "@/lib/contact-fields/select-values";
import {
  buildCustomFieldsDisplay,
  type ContactLike,
  type ResolverExtras,
} from "@ccp/shared/field-tokens";
import {
  workflowContactSnapshot,
  type WorkflowEventEnvelope,
} from "@/lib/workflows/events";

import { envelopeContact, envelopeExtras, type StepRunContext } from "./types";

const EMPTY_CONTACT: ContactLike = { name: "", phoneNumber: null, customFields: {} };

/**
 * Load a contact by id as a COMPLETE `ContactLike` for token resolution —
 * joins Stage + Tags and reads `lastInboundAt` so EVERY `$var.contact.*` token
 * resolves, including the derived ones (`stage_name`, `tag_names`,
 * `window_state`, `last_inbound_at`).
 *
 * Why re-read instead of trusting `envelopeContact`: the trigger snapshot is
 * built on the hot ingest path and deliberately does NOT join stage/tag names
 * (cost), so those tokens came back empty. The workflow runs in the async
 * worker, where one extra contact read per step is free — so we load fresh.
 * `workflowContactSnapshot` does the derivation; its result is a ContactLike
 * superset.
 */
export async function loadContactLikeById(
  workspaceId: string,
  contactId: string | null | undefined,
): Promise<ContactLike> {
  if (!contactId) return EMPTY_CONTACT;
  const row = await db.contact.findFirst({
    where: { id: contactId, workspaceId },
    include: {
      stage: { select: { name: true } },
      tags: { select: { id: true, name: true } },
    },
  });
  if (!row) return EMPTY_CONTACT;
  const snapshot = workflowContactSnapshot(row);
  // Select-type fields store option IDS in customFields; tokens should
  // render the option NAME. The overlay is a SEPARATE key on the ContactLike
  // — `customFields` stays raw, so `field_equals` branch evaluation (which
  // reads the same object — branch-presets invariant IX) keeps comparing
  // against stored ids. Catalog comes from a 5-min memo; empty for
  // workspaces with no select fields.
  const selectDefs = await loadSelectFieldDisplayDefs(workspaceId);
  if (selectDefs.length > 0) {
    return {
      ...snapshot,
      customFieldsDisplay: buildCustomFieldsDisplay(selectDefs, row.customFields),
    };
  }
  return snapshot;
}

/**
 * Build the `(contact, extras)` pair every token-resolving step needs:
 *   - `contact` → the step's resolution target (a custom-phone target, or the
 *     trigger contact by default), loaded COMPLETE — drives `$var.contact.*`.
 *   - `extras.triggerContact` → the ORIGINAL trigger sender, also loaded
 *     complete, so `$var.sender.*` / `$var.trigger.contact.*` fill fully even
 *     when the step sends to a different target.
 */
export async function buildTokenContext(
  envelope: WorkflowEventEnvelope,
  ctx: StepRunContext,
  workspaceId: string,
  resolveContactId: string | null | undefined,
): Promise<{ contact: ContactLike; extras: ResolverExtras }> {
  const contact = await loadContactLikeById(workspaceId, resolveContactId);
  const extras = envelopeExtras(envelope, ctx);
  const triggerId = envelopeContact(envelope)?.id;
  if (triggerId) {
    extras.triggerContact =
      triggerId === resolveContactId
        ? contact
        : await loadContactLikeById(workspaceId, triggerId);
  }
  return { contact, extras };
}
