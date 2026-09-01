import {
  COLLECT_BUILTIN_TARGETS,
  detailKey,
  parseCollectFields,
  type CollectFieldSpec,
} from "@ccp/shared/ai/collect-details";

import { loadSelectFieldCatalog, resolveSelectValue } from "@/lib/contact-fields/select-values";
import { db } from "@/lib/db";
import { publish } from "@/lib/events/bus";
import { normalizeStringMap } from "@/lib/normalize-string-map";
import { looksLikeIdentityFallback, splitContactName } from "@/lib/providers/ingest";
import { toContactWire } from "@/lib/queries/_shared";
import { workflowContactSnapshot } from "@/lib/workflows/events";

/**
 * Filling in the contact details the assistant is missing — whichever ones the
 * admin listed in `AiAssistantConfig.collectFields`.
 *
 * The flow is: we notice a configured detail is blank → the prompt tells the
 * model to ask for it, once → the customer answers → we validate and store it
 * on the Contact. Each half is deliberately separate from the other, because
 * they fail differently: the ASK is a judgement call the model makes ("is this
 * a natural moment?"), while the CAPTURE must not be, so nothing the model
 * reports is trusted without re-validation here.
 *
 * What this is NOT: an identity signal. Nothing collected here reaches
 * IdentityService — see the header of `@ccp/shared/ai/collect-details` for why
 * phone is not even offered as a target, and §6 for the rule it follows.
 */

/**
 * Deliberately strict, and stricter than RFC 5322 allows. This validates a
 * value a MODEL handed us, so the job is to reject anything that merely looks
 * email-shaped rather than to accept every address that could legally exist —
 * a wrong address written into the customer's profile is worse than a missed
 * one, which the next conversation picks up anyway.
 */
const EMAIL = /^[^\s@,;:<>()[\]\\"]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/** Free-text ceilings, matching what the REST contact schemas accept. */
const MAX_NAME = 120;
const MAX_LOCATION = 200;
const MAX_CUSTOM = 500;

const BUILTIN_NOUN = new Map(COLLECT_BUILTIN_TARGETS.map((t) => [t.target as string, t.noun]));

/** One configured detail, resolved against what this contact already has. */
export interface CollectibleDetail {
  spec: CollectFieldSpec;
  /** Stable id the model names and the "asked" marker uses. */
  key: string;
  /** How the assistant refers to it when asking ("email address", "order number"). */
  noun: string;
  /** Already on file — nothing to ask for. */
  onFile: boolean;
  /** The stored value when `onFile`, so the reply can use it ("we'll email
   *  your receipt to …"). Empty otherwise. */
  value: string;
  /** Already asked on this thread — do not ask again. */
  asked: boolean;
}

export interface ContactDetails {
  /** The configured list, in the admin's order, resolved against this contact. */
  details: CollectibleDetail[];
}

/**
 * What the prompt needs to know about this customer's details.
 *
 * Reads the CONTACT (the channel identity that owns the conversation), not the
 * Customer — these are the columns the inbox's right-rail panel renders, so a
 * value the assistant collects shows up exactly where an agent expects it.
 *
 * A `custom` entry naming a definition that no longer exists is dropped rather
 * than asked for: the admin deleted the field, and asking a customer for
 * something we have nowhere to put is worse than not asking.
 */
export async function loadContactDetails(
  workspaceId: string,
  conversationId: string,
  collectFields: unknown,
): Promise<ContactDetails> {
  const specs = parseCollectFields(collectFields);
  if (!specs.length) return { details: [] };

  const conv = await db.conversation.findFirst({
    where: { id: conversationId, workspaceId },
    select: {
      contact: {
        select: { name: true, email: true, location: true, customFields: true },
      },
    },
  });
  const contact = conv?.contact;
  if (!contact) return { details: [] };

  const state = await db.aiConversationState.findFirst({
    where: { conversationId, workspaceId },
    select: { requestedDetails: true },
  });
  const asked = normalizeStringMap(state?.requestedDetails);
  const custom = normalizeStringMap(contact.customFields);

  // One query for every custom label, rather than one per entry.
  const customKeys = specs
    .filter((s) => s.target === "custom" && s.key)
    .map((s) => s.key as string);
  const definitions = customKeys.length
    ? await db.contactFieldDefinition.findMany({
        where: { workspaceId, key: { in: customKeys } },
        select: { key: true, label: true },
      })
    : [];
  const labelByKey = new Map(definitions.map((d) => [d.key, d.label]));

  const details: CollectibleDetail[] = [];
  for (const spec of specs) {
    const key = detailKey(spec);
    let noun: string;
    let value = "";
    let onFile: boolean;

    if (spec.target === "custom") {
      const label = labelByKey.get(spec.key ?? "");
      if (!label) continue; // definition deleted — nowhere to put an answer
      noun = label.toLowerCase();
      value = custom[spec.key as string]?.trim() ?? "";
      onFile = !!value;
    } else {
      noun = BUILTIN_NOUN.get(spec.target) ?? spec.target;
      if (spec.target === "email") {
        value = contact.email?.trim() ?? "";
      } else if (spec.target === "location") {
        value = contact.location?.trim() ?? "";
      } else {
        // A name is "on file" only when it is a REAL name. `Contact.name` falls
        // back to the phone number / visitor handle so the inbox has something
        // to render, and treating that as an answer means never asking the one
        // question most likely to be missing.
        const stored = contact.name?.trim() ?? "";
        value = stored && !looksLikeIdentityFallback(stored) ? stored : "";
      }
      onFile = !!value;
    }

    details.push({ spec, key, noun, value, onFile, asked: !!asked[key] });
  }
  return { details };
}

/** The one detail to ask for now, or null when there is nothing left to ask. */
export function nextDetailToAsk(details: CollectibleDetail[]): CollectibleDetail | null {
  return details.find((d) => !d.onFile && !d.asked) ?? null;
}

/** One `{ key, value }` pair as the model reported it — untrusted. */
export interface CollectedDetailInput {
  key: string;
  value: string;
}

/**
 * Persist details the customer just gave us.
 *
 * Only fills BLANKS — a value an agent typed, a CSV import set, or the customer
 * gave earlier always wins over a fresh model extraction. Every value is
 * re-validated here against its target's own rules; a model asked for a field
 * will happily invent a plausible one, and the whole point of this function is
 * that nothing it was told is taken on trust.
 *
 * Only keys that are actually CONFIGURED and actually missing are considered,
 * so a model naming a field the admin never asked for writes nothing.
 *
 * Returns the detail keys that were stored (empty when nothing was).
 */
export async function captureContactDetails(
  workspaceId: string,
  conversationId: string,
  details: CollectibleDetail[],
  reported: CollectedDetailInput[],
): Promise<string[]> {
  if (!details.length || !reported.length) return [];

  // Only fields we asked about and don't already hold can be written.
  const wanted = new Map(details.filter((d) => !d.onFile).map((d) => [d.key, d]));
  const claims: Array<{ detail: CollectibleDetail; value: string }> = [];
  const seen = new Set<string>();
  for (const item of reported) {
    const detail = wanted.get((item.key ?? "").trim());
    if (!detail || seen.has(detail.key)) continue;
    const value = (item.value ?? "").trim();
    if (!value) continue;
    seen.add(detail.key);
    claims.push({ detail, value });
  }
  if (!claims.length) return [];

  const conv = await db.conversation.findFirst({
    where: { id: conversationId, workspaceId },
    select: { contactId: true },
  });
  if (!conv) return [];

  const contact = await db.contact.findFirst({
    where: { id: conv.contactId, workspaceId, deletedAt: null },
    select: {
      id: true,
      name: true,
      email: true,
      location: true,
      customFields: true,
      version: true,
    },
  });
  if (!contact) return [];

  const existingCf = normalizeStringMap(contact.customFields);
  const patch: Record<string, unknown> = {};
  const cfPatch: Record<string, string> = {};
  const stored: string[] = [];

  // A SELECT-type custom field stores an option id, never the customer's raw
  // words. One catalog query for every custom claim; an unresolvable answer is
  // skipped, the same lenient posture the pre-chat and workflow save paths take.
  const customClaimKeys = claims
    .filter((c) => c.detail.spec.target === "custom")
    .map((c) => c.detail.spec.key as string);
  const selectCatalog = customClaimKeys.length
    ? await loadSelectFieldCatalog(workspaceId, customClaimKeys)
    : new Map();

  for (const { detail, value } of claims) {
    const { target } = detail.spec;
    if (target === "email") {
      const email = value.toLowerCase();
      if (email.length > 254 || !EMAIL.test(email)) continue;
      if (contact.email?.trim()) continue;
      patch.email = email;
    } else if (target === "location") {
      if (contact.location?.trim()) continue;
      patch.location = value.slice(0, MAX_LOCATION);
    } else if (target === "full_name") {
      // Never overwrite a real name, and never accept an "answer" that is
      // itself an identity fallback (a model echoing the phone number back).
      if (contact.name?.trim() && !looksLikeIdentityFallback(contact.name)) continue;
      const name = value.slice(0, MAX_NAME);
      if (looksLikeIdentityFallback(name)) continue;
      patch.name = name;
      const parts = splitContactName(name);
      patch.firstName = parts.firstName;
      patch.lastName = parts.lastName;
    } else {
      const key = detail.spec.key as string;
      if (existingCf[key]?.trim()) continue;
      const entry = selectCatalog.get(key);
      if (entry) {
        const match = resolveSelectValue(entry, value);
        if (!match.ok) continue;
        cfPatch[key] = match.id;
      } else {
        cfPatch[key] = value.slice(0, MAX_CUSTOM);
      }
    }
    stored.push(detail.key);
  }

  const cfChanged = Object.keys(cfPatch).length > 0;
  if (!Object.keys(patch).length && !cfChanged) return [];

  // CAS on the version we READ. The customFields write is a read-modify-write
  // over that snapshot, so an agent PATCH committing in between would otherwise
  // have its edits silently overwritten. Losing the race drops only this
  // enrichment pass — the customer's answer is still in the thread and the next
  // reply re-extracts it — which beats erasing an agent's work.
  const written = await db.contact.updateMany({
    where: { id: contact.id, workspaceId, version: contact.version },
    data: {
      ...patch,
      ...(cfChanged ? { customFields: { ...existingCf, ...cfPatch } } : {}),
      version: { increment: 1 },
    },
  });
  if (written.count === 0) return [];

  // Announce the change — the same publish the PATCH route, the contact-share
  // chip and the webchat pre-chat form use, so the contact panel, the contacts
  // list and every subscribed partner see it without a refetch.
  //
  // Best-effort: this runs after the assistant's reply has committed, and a
  // publish failure must never cost us the captured values.
  try {
    const fresh = await db.contact.findUnique({
      where: { id: contact.id },
      include: { tags: { select: { id: true } } },
    });
    if (fresh) {
      await publish({
        type: "contact.updated",
        workspaceId,
        contact: toContactWire(fresh),
        previousStageId: fresh.stageId,
        fieldChanges: [],
        changedByUserId: null,
        workflowContact: workflowContactSnapshot(fresh),
      });
    }
  } catch (err) {
    console.error(
      `[ai/contact-details] publish(contact.updated) failed for team=${workspaceId} contact=${contact.id}:`,
      err,
    );
  }
  return stored;
}

/**
 * Record that the assistant asked for a detail on this thread, so it never asks
 * twice. Best-effort: the reply has already been sent by the time this runs,
 * and failing to write the marker is worth at most one repeated question.
 *
 * Read-modify-write on the JSON map, guarded by the row's own state: two AI
 * turns on one conversation are already prevented upstream by the atomic
 * inbound claim, so there is no concurrent writer to race here.
 */
export async function markDetailRequested(
  workspaceId: string,
  conversationId: string,
  key: string,
): Promise<void> {
  if (!key) return;
  try {
    const state = await db.aiConversationState.findFirst({
      where: { conversationId, workspaceId },
      select: { requestedDetails: true },
    });
    if (!state) return;
    const asked = normalizeStringMap(state.requestedDetails);
    if (asked[key]) return;
    await db.aiConversationState.updateMany({
      where: { conversationId, workspaceId },
      data: { requestedDetails: { ...asked, [key]: new Date().toISOString() } },
    });
  } catch {
    // Bookkeeping only.
  }
}
