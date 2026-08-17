import { loadSelectFieldCatalog, resolveSelectValue } from "@/lib/contact-fields/select-values";
import { db } from "@/lib/db";
import { publish } from "@/lib/events/bus";
import { toContactWire } from "@/lib/queries/_shared";
import { workflowContactSnapshot } from "@/lib/workflows/events";
import { normalizeStringMap } from "@/lib/normalize-string-map";
import { splitContactName } from "@/lib/providers/ingest";
import { normalizePhoneE164 } from "@ccp/shared/utils/phone";
import { isReservedFieldKey } from "@ccp/shared/contacts/reserved-fields";
import type { WebchatwidgetConfig } from "@/lib/providers/webchatwidget-config";
import type { Channel } from "@ccp/shared/types";

/**
 * Apply a website-widget pre-chat form submission to the visitor's contact.
 *
 * The pre-chat form LOOKS like the social "share your phone / email" consent chip
 * (see `applyContactShareFromReply`), but it is NOT equivalent and must not be
 * treated as one: the social chip rides on a vendor-verified account, while this is
 * an unauthenticated text box on a public website. The values are STORED on the
 * contact (the agent can see and act on them) but NEVER act as a merge key in
 * either direction — see the NO-AUTO-MERGE block below, and the matching candidate
 * exclusion in `findExistingCustomerIdByStrongKey`. Name is display-only — never a
 * key (no fuzzy matching, ever — lib/identity/identity-service.ts).
 *
 * Landing a phone or email here DOES promote the visitor out of ephemeral status
 * into the contacts directory (`directoryContactWhere`) — that is visibility, not
 * identity, and it mints no link to any other person.
 *
 * Best-effort, called AFTER the first inbound message has committed: a failure
 * here must never cost us the message. The customer-link drift sweeper is the
 * backstop for the `customerId` half.
 */
/** Lowercase + underscored slug from a label — mirrors the ContactFieldDefinition
 *  key scheme (contact-fields.service.ts) so a pre-chat "Company" field lands under
 *  the same `company` key an admin-created field would. */
function slugifyFieldKey(label: string): string {
  return label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

/** A custom pre-chat field whose label maps to a KNOWN person column sets that
 *  column directly instead of minting a custom field \u2014 e.g. "First name" \u2192
 *  `firstName`, "Language" \u2192 `language`. Anything else (an org's "Order ID",
 *  "xID", \u2026) becomes a custom field. Identity columns (name/email/phone) are NOT
 *  here \u2014 they arrive via the dedicated field TYPEs and carry merge semantics this
 *  anonymous surface must not trigger from a free-text label. */
const BUILTIN_FIELD_BY_SLUG: Record<string, "firstName" | "lastName" | "language" | "countryCode" | "location"> = {
  first_name: "firstName",
  firstname: "firstName",
  first: "firstName",
  last_name: "lastName",
  lastname: "lastName",
  last: "lastName",
  surname: "lastName",
  language: "language",
  lang: "language",
  country: "countryCode",
  country_code: "countryCode",
  location: "location",
  address: "location",
};

/**
 * Coerce a visitor-typed value to what its target column actually stores, or
 * `null` to refuse it. Free-text columns (name parts, location) take the value
 * as-is, capped; the coded ones are validated to the same shape the REST contact
 * schemas enforce, so every writer of these columns agrees.
 */
function normalizeBuiltinValue(
  column: "firstName" | "lastName" | "language" | "countryCode" | "location",
  raw: string,
): string | null {
  const v = raw.trim();
  if (!v) return null;
  if (column === "countryCode") {
    // ISO 3166-1 alpha-2, stored uppercase (contacts.schemas.ts CountryCodeSchema).
    return /^[A-Za-z]{2}$/.test(v) ? v.toUpperCase() : null;
  }
  if (column === "language") {
    // BCP-47 tag, e.g. "ar", "en-US" (contacts.schemas.ts LanguageSchema: 2–12).
    return /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(v) && v.length <= 12 ? v : null;
  }
  return v.slice(0, 120);
}

/**
 * The custom-field targets a widget is ALLOWED to write, as `key → label`.
 *
 * `preChat` arrives from an anonymous, unauthenticated browser, and every key it
 * carried used to be honoured — including keys naming no configured question. A
 * scripted client could therefore mint contact fields at will in the tenant's
 * workspace, bypassing the 50-field cap the settings service enforces, and each
 * one shows up in the contact panel, exports, filters and the token picker. The
 * widget's OWN configuration is the authority on what it may collect, so answers
 * are intersected against it and anything else is dropped.
 *
 * The label is carried so a resurrected definition is named after the question
 * ("Company") rather than its raw slug ("company").
 */
export function preChatFieldTargets(config: WebchatwidgetConfig): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of config.preChatFields ?? []) {
    if (f.type !== "text") continue;
    // Bound questions carry the key; legacy ones still derive it from the label.
    // An explicit key is already a canonical ContactFieldDefinition key (and can
    // carry a `_2` collision suffix) — slugifying it again risks truncating it.
    const key = f.key ? f.key.trim() : slugifyFieldKey(f.label);
    if (key) out.set(key, (f.label || key).trim().slice(0, 60));
  }
  return out;
}

export async function applyWebchatPreChatIdentity(
  workspaceId: string,
  channel: Channel,
  contactId: string,
  fields: {
    name?: string | null;
    email?: string | null;
    phone?: string | null;
    custom?: Record<string, string> | null;
  },
  /** What this widget is configured to collect (see preChatFieldTargets). When
   *  omitted every key is accepted — kept for callers with no widget context. */
  allowedCustom?: ReadonlyMap<string, string>,
): Promise<void> {
  const name = fields.name?.trim() || null;
  const email = fields.email?.trim().toLowerCase() || null;
  // Store phone digits-only like every other channel (partial unique on
  // (workspaceId, phoneNumber) is whatsapp-scoped, so stamping it on a widget contact
  // can't collide — it's exactly the pair we want resolveCustomerId to fuse).
  const phone = fields.phone ? normalizePhoneE164(fields.phone) : null;
  const hasCustom = fields.custom != null && Object.keys(fields.custom).length > 0;
  // A visitor who typed a phone we could not resolve to E.164 (a national form
  // with no country to resolve it WITH — the widget has no default country to
  // plumb) still told us something. `normalizePhoneE164` refuses to store such
  // a value as an identity, and rightly so, but treating the whole submission
  // as empty would ALSO throw away the name and email beside it, and leave the
  // visitor un-promoted out of ephemeral status. So: proceed on the raw value's
  // presence, and let the unusable digits simply not become the phone identity.
  const submittedPhone = Boolean(fields.phone?.trim());
  if (!name && !email && !phone && !submittedPhone && !hasCustom) return;

  const contact = await db.contact.findFirst({
    where: { id: contactId, workspaceId, deletedAt: null },
    select: {
      id: true,
      name: true,
      phoneNumber: true,
      email: true,
      customerId: true,
      customFields: true,
      version: true,
      firstName: true,
      lastName: true,
      language: true,
      countryCode: true,
      location: true,
    },
  });
  if (!contact) return;

  const next: {
    name: string;
    phoneNumber: string | null;
    email: string | null;
    firstName?: string | null;
    lastName?: string | null;
  } = {
    name: name ?? contact.name,
    phoneNumber: phone ?? contact.phoneNumber,
    email: email ?? contact.email,
  };
  // A single "name" field is the display name AND the source of firstName/lastName:
  // first word → firstName, the rest → lastName ("Ali Al Ahmad" → "Ali" / "Al Ahmad";
  // "Ali" → firstName only). Same split the inbound webhook path uses. An explicit
  // "First name"/"Last name" pre-chat field still wins (builtinPatch applies after).
  if (name) {
    const parts = splitContactName(name);
    next.firstName = parts.firstName;
    next.lastName = parts.lastName;
  }
  // Custom (non-identity) pre-chat fields → the contact's customFields JSON. A
  // field the org labelled "Company" / "Order number" is real data the agent needs,
  // and must NOT overwrite the name (the old code mapped every non-email/phone field
  // to `name`). Keyed by a slug of the label — the same scheme ContactFieldDefinition
  // uses — and we ensure a definition exists so the value actually renders in the
  // contact panel instead of sitting invisibly in the JSON.
  const existingCf = normalizeStringMap(contact.customFields);
  const cfPatch: Record<string, string> = {};
  const ensureDefs: Array<{ key: string; label: string }> = [];
  // A custom field whose label maps to a known person column is set on that column
  // directly (it's a first-class field the contacts system already understands),
  // NOT stored as a custom field.
  const builtinPatch: Partial<Record<"firstName" | "lastName" | "language" | "countryCode" | "location", string>> = {};
  const candidates: Array<{ key: string; label: string; val: string }> = [];
  for (const [label, rawVal] of Object.entries(fields.custom ?? {})) {
    const key = slugifyFieldKey(label);
    const val = String(rawVal ?? "").trim().slice(0, 1000);
    if (!key || !val) continue;
    // Same reserved-key guard the contact-fields settings enforce: a custom
    // pre-chat field labeled "Email" slugifies to `email` and would upsert a
    // definition shadowing the built-in column — two "Email" fields writing to
    // different storage (audit 2026-08-10). BUILTIN_FIELD_BY_SLUG below
    // diverts the mappable ones; anything else reserved is dropped, not
    // stored under a colliding key.
    if (isReservedFieldKey(key) && !BUILTIN_FIELD_BY_SLUG[key]) continue;
    // Not a question this widget asks → not ours to store, and certainly not
    // ours to create a workspace-wide field for.
    if (allowedCustom && !allowedCustom.has(key)) continue;
    // Prefer the CONFIGURED label over the submitted one for anything we may end
    // up creating a definition from.
    candidates.push({ key, label: allowedCustom?.get(key) ?? label, val });
  }
  // A REAL definition outranks the alias map. Most alias keys (`first_name`,
  // `location`, …) are reserved, so no definition can exist for them and the
  // column always wins — but five are NOT reserved (`address`, `surname`,
  // `first`, `last`, `lang`), so a workspace can legitimately create a custom
  // field called "Address". Consulting the alias first sent that field's answers
  // to `Contact.location` and left the field the admin created empty — a value
  // stored somewhere nobody was looking. An explicitly created field is an
  // explicit intent; only fall back to the column when no definition exists.
  const definedKeys = new Set(
    candidates.length === 0
      ? []
      : (
      await db.contactFieldDefinition.findMany({
        where: { workspaceId, key: { in: candidates.map((c) => c.key) } },
        select: { key: true },
      })
    ).map((d) => d.key),
  );
  for (let i = candidates.length - 1; i >= 0; i--) {
    const candidate = candidates[i];
    if (!candidate) continue;
    const { key, val } = candidate;
    const builtin = BUILTIN_FIELD_BY_SLUG[key];
    if (!builtin || definedKeys.has(key)) continue;
    const clean = normalizeBuiltinValue(builtin, val);
    // A CODED column refuses a value it can't honour rather than storing prose.
    // `countryCode` is ISO-3166 alpha-2 and `language` is BCP-47 — every other
    // write path enforces that (contacts.schemas.ts) and the panel, templates and
    // workflows all read them as codes. A visitor typing "Lebanon" into a pre-chat
    // "Country" question would otherwise poison a column the product treats as
    // machine-readable. Dropping is right: the question is optional context, not
    // the reason they came, and a wrong code is worse than none.
    if (clean === null) { candidates.splice(i, 1); continue; }
    // Known contact column → set it directly (skip if already that value).
    if (contact[builtin] !== clean) builtinPatch[builtin] = clean;
    candidates.splice(i, 1);
  }
  // A key that belongs to a SELECT-type definition must store an option ID, never
  // the visitor's raw text — an unresolvable value is skipped, the same lenient
  // posture the workflow ask_question save takes (steps/ask-question.ts). One
  // catalog query (skipped internally when there are no keys); text/one-off keys
  // don't appear in it and keep raw-text behavior.
  const selectCatalog = await loadSelectFieldCatalog(
    workspaceId,
    candidates.map((c) => c.key),
  );
  for (const { key, label, val } of candidates) {
    const entry = selectCatalog.get(key);
    if (entry) {
      const match = resolveSelectValue(entry, val);
      if (!match.ok) continue;
      // Idempotency compares the RESOLVED id — a re-submitted form must no-op.
      if (existingCf[key] === match.id) continue;
      cfPatch[key] = match.id;
      // The definition exists by construction — nothing to ensure.
      continue;
    }
    if (existingCf[key] === val) continue;
    cfPatch[key] = val;
    // 60 = MAX_LABEL (workspace-settings/contact-fields/contact-fields.schemas.ts)
    ensureDefs.push({ key, label: label.trim().slice(0, 60) });
  }
  const cfChanged = Object.keys(cfPatch).length > 0;
  const builtinChanged = Object.keys(builtinPatch).length > 0;

  // Idempotent: a re-submitted form (or a redelivered first message) must not churn
  // the row or re-run the merge.
  if (
    next.name === contact.name &&
    next.phoneNumber === contact.phoneNumber &&
    next.email === contact.email &&
    !cfChanged &&
    !builtinChanged
  ) {
    return;
  }

  // CAS on the version this function READ. The customFields write is a
  // read-modify-write over that snapshot ({ ...existingCf, ...cfPatch }), so
  // an agent PATCH committing between our read and this write used to have
  // its custom-field edits silently overwritten (audit 2026-08-10). Losing
  // the race drops only this pre-chat enrichment pass — the visitor's answers
  // are re-appliable and the next pre-chat submit re-runs it — which beats
  // silently erasing an agent's work. The bump also makes the enrichment
  // visible to any concurrent PATCH's own CAS.
  const enriched = await db.contact.updateMany({
    where: { id: contact.id, version: contact.version },
    data: {
      ...next,
      ...builtinPatch,
      ...(cfChanged ? { customFields: { ...existingCf, ...cfPatch } } : {}),
      version: { increment: 1 },
    },
  });
  if (enriched.count === 0) return;

  // Make each new custom field visible in the contact panel. Best-effort + race-
  // safe: the @@unique([workspaceId, key]) means a concurrent create just no-ops.
  for (const def of ensureDefs) {
    await db.contactFieldDefinition
      .upsert({
        where: { workspaceId_key: { workspaceId, key: def.key } },
        create: { workspaceId, key: def.key, label: def.label },
        update: {},
      })
      .catch(() => undefined);
  }

  // NO AUTO-MERGE from this surface — deliberately.
  //
  // §6 allows auto-merge on a strong key only when it is SELF-ASSERTED, and on
  // WhatsApp/Messenger/Instagram that means something: the vendor already verified
  // the channel identity, so the person asserting the email provably controls that
  // account. A webchat visitor is ANONYMOUS and has proven nothing — the pre-chat
  // form is an unauthenticated public text box on the client's website. Trusting it
  // as a strong key let anyone type a known customer's email or phone and have
  // their throwaway session adopted into that person's unified Customer, after
  // which the contact panel and linked-channels switcher present the stranger as
  // the verified customer. That is an impersonation vector against a surface agents
  // trust, so the values are stored on the Contact (the agent can see and act on
  // them) and merging is left to the MANUAL, reversible path — exactly the posture
  // §6 prescribes for everything that isn't a deterministic verified key.
  //
  // Re-enabling this requires verifying the address/number first (emailed or SMS'd
  // code), not loosening the check here.

  // Announce the change so the contact panel / linked-channels switcher / partner
  // webhooks refresh — same publish the PATCH route + contact-share path use.
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
      `[webchat-prechat] publish(contact.updated) failed for team=${workspaceId} contact=${contact.id}:`,
      err,
    );
  }

  console.info(
    JSON.stringify({
      event: "identity.webchat_prechat_applied",
      channel,
      contactId: contact.id,
      gotEmail: Boolean(email),
      gotPhone: Boolean(phone),
    }),
  );
}
