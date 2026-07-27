import { redirect } from "next/navigation";

import { getSession } from "@/lib/auth/current-user";
import {
  countAllContacts,
  getBroadcast,
  getBroadcastRecipientContactIds,
  getTeamWhatsappConfig,
  listAssignmentPolicies,
  listAudienceGroups,
  listContactFieldDefinitions,
  listContactStages,
  listTags,
  listTeamMembers,
  listWhatsappTemplates,
  lookupContacts,
} from "@/lib/api/queries";

import { NewBroadcastForm } from "./new-broadcast-form";

export const metadata = { title: "New broadcast" };
export const dynamic = "force-dynamic";

export default async function NewBroadcastPage({
  searchParams,
}: {
  // Pre-fill from the URL: `?contactIds=a,b,c` after a Contacts-page bulk
  // "Send template"; `?groupId=...` after clicking "Send broadcast" on a
  // saved group; `?tagIds=...` for tag-based deeplinks.
  searchParams: Promise<{
    contactIds?: string | string[];
    tagIds?: string | string[];
    groupId?: string | string[];
    // `?from=<id>` — duplicate an existing broadcast: prefill template +
    // variables + audience from it. The agent reviews + sends (or schedules)
    // a fresh broadcast; nothing is mutated on the source.
    from?: string | string[];
    // `?channel=whatsapp|messenger|instagram` — the Outreach nav is scoped to a
    // channel, so opening the composer from it lands on that channel already
    // selected instead of always defaulting to WhatsApp.
    channel?: string | string[];
  }>;
}) {
  const { permissions } = await getSession();
  if (!permissions["broadcasts:manage"]) redirect("/broadcasts");

  const sp = await searchParams;
  const fromId =
    typeof sp.from === "string" && sp.from.trim().length > 0 ? sp.from.trim() : null;

  // Clone source (best-effort — a stale/foreign id just falls through to an
  // empty form rather than erroring).
  const source = fromId ? await getBroadcast(fromId).catch(() => null) : null;
  // For a hand-picked clone (`selected`/`custom`) the resolved contact set only
  // lives on BroadcastRecipient rows — reconstruct it so "Duplicate" carries
  // the same audience instead of landing on an empty builder. An `all` clone
  // passes a flag so the form opens in All-contacts mode; tag/group clones
  // already carry through their refs.
  const cloneContactIds =
    source &&
    (source.audienceMode === "selected" || source.audienceMode === "custom")
      ? await getBroadcastRecipientContactIds(source.id).catch(() => [])
      : [];
  const clone = source
    ? {
        templateId: source.templateId,
        variables: parseCloneVariables(source.variables),
        audienceMode: source.audienceMode,
        tagIds: source.audienceTagIds ?? [],
        groupId: source.audienceGroupId ?? null,
        contactIds: cloneContactIds,
        // Message content — without these, duplicating a freeform / People
        // broadcast silently dropped its kind + channel + body and reopened as
        // an empty WhatsApp-template composer.
        kind: source.kind,
        targetMode: source.targetMode,
        channel: source.channel,
        bodyText: source.bodyText,
      }
    : null;
  // Reproduce the source's message kind on duplicate rather than defaulting to
  // "template": a freeform-to-one-channel clone reopens as freeform on that
  // channel and carries the original body text. A legacy customer-mode
  // ("People / best channel") source — the mode was removed 2026-07-27 —
  // reopens as freeform too: the body carries over, the operator picks the
  // channel (the form maps the sentinel).
  const cloneMessageKind: "template" | "freeform" | "customer" | null = clone
    ? clone.kind === "template"
      ? "template"
      : clone.targetMode === "customer"
        ? "customer" // form coerces to freeform
        : "freeform"
    : null;

  // Audience prefill — clone's audience wins; otherwise the deep-link params.
  const preselectedContactIds =
    clone && clone.contactIds.length > 0
      ? clone.contactIds
      : normalizeIds(sp.contactIds);
  const preselectedTagIds =
    clone && clone.tagIds.length > 0 ? clone.tagIds : normalizeIds(sp.tagIds);
  const preselectedGroupId =
    clone?.groupId ??
    (typeof sp.groupId === "string" && sp.groupId.trim().length > 0
      ? sp.groupId.trim()
      : null);
  // All-contacts clone: tell the form to open in "all" mode (there's no id
  // set to carry — it's "everyone at send time").
  const preselectAllAudience = clone?.audienceMode === "all";

  // The wizard never loads the whole contact list — it works off ids and
  // resolves counts / chip labels server-side. So all we fetch here is the
  // team total, the small tag/group/field catalogs, and the labels for any
  // contacts that were deep-linked in.
  const [
    config,
    totalContactCount,
    tags,
    groups,
    fieldDefinitions,
    stages,
    contactLabels,
    templatesResult,
    members,
    assignmentPolicies,
  ] = await Promise.all([
    getTeamWhatsappConfig(),
    countAllContacts(),
    listTags(),
    listAudienceGroups(),
    listContactFieldDefinitions(),
    listContactStages(),
    lookupContacts(preselectedContactIds),
    // Seed the Template step server-side so it isn't blank-then-spinner on
    // first paint. Best-effort: a Meta/connectivity hiccup falls through to an
    // empty list and the form's "Refresh" button re-fetches from the client.
    listWhatsappTemplates().catch(() => null),
    // Roster + routing policies for the campaign-assignment step. Best-effort:
    // a failure just hides the step rather than blocking the composer.
    listTeamMembers().catch(() => []),
    listAssignmentPolicies().catch(() => []),
  ]);
  const teamMembers = members
    .filter((m) => m.isActive)
    .map((m) => ({ id: m.id, name: m.name }));

  // Pre-flight: if WhatsApp isn't even connected, bounce to the settings
  // page so the user knows what to fix.
  if (!config.phoneNumberId) {
    redirect("/settings/whatsapp?from=broadcasts");
  }

  return (
    <NewBroadcastForm
      totalContactCount={totalContactCount}
      initialContactLabels={contactLabels}
      initialTemplates={templatesResult?.templates ?? []}
      tags={tags}
      fieldDefinitions={fieldDefinitions}
      stages={stages}
      groups={groups}
      hasWabaId={Boolean(config.wabaId)}
      preselectedContactIds={preselectedContactIds}
      preselectedTagIds={preselectedTagIds}
      preselectedGroupId={preselectedGroupId}
      preselectAllAudience={preselectAllAudience}
      cloneTemplateId={clone?.templateId ?? null}
      cloneBodyVars={clone?.variables.body ?? null}
      cloneHeaderVar={clone?.variables.header ?? null}
      cloneKind={cloneMessageKind}
      cloneBodyText={clone?.bodyText ?? null}
      cloneChannel={clone?.channel ?? null}
      // A clone's own channel wins — the point of duplicating is to repeat it.
      initialChannel={
        clone
          ? null
          : ((Array.isArray(sp.channel) ? sp.channel[0] : sp.channel) ?? null)
      }
      teamMembers={teamMembers}
      assignmentPolicies={assignmentPolicies}
    />
  );
}

function normalizeIds(raw: string | string[] | undefined): string[] {
  if (!raw) return [];
  // ?ids=a,b,c (string) OR ?ids=a&ids=b (array) — accept both.
  const arr = Array.isArray(raw) ? raw : raw.split(",");
  return Array.from(new Set(arr.map((s) => s.trim()).filter((s) => s.length > 0)));
}

/** Best-effort parse of a broadcast's stored `variables` JSON for clone. */
function parseCloneVariables(raw: unknown): { body: string[]; header?: string } {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as { body?: unknown; header?: unknown };
    const body = Array.isArray(o.body) ? o.body.filter((v): v is string => typeof v === "string") : [];
    const header = typeof o.header === "string" ? o.header : undefined;
    return { body, ...(header ? { header } : {}) };
  }
  return { body: [] };
}
