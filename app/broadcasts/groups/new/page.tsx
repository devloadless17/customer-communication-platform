import { redirect } from "next/navigation";

import { getSession } from "@/lib/current-user";
import { db } from "@/lib/db";
import { listTags } from "@/lib/queries";
import type { Contact } from "@/lib/types";

import { GroupForm } from "@/components/audience-groups/group-form";

export const metadata = { title: "New audience group" };
export const dynamic = "force-dynamic";

export default async function NewGroupPage() {
  const { teamId } = await getSession();

  const [team, contacts, tags] = await Promise.all([
    db.team.findUnique({
      where: { id: teamId },
      select: { metaPhoneNumberId: true },
    }),
    db.contact.findMany({
      where: { teamId },
      orderBy: { name: "asc" },
      select: {
        id: true,
        teamId: true,
        phoneNumber: true,
        name: true,
        email: true,
        location: true,
        avatarUrl: true,
        customFields: true,
        source: true,
        tags: { select: { id: true } },
      },
    }),
    listTags(teamId),
  ]);

  // Pre-flight: groups are only useful when WhatsApp is connected (you need
  // it to send the broadcast eventually). If not, bounce to settings.
  if (!team?.metaPhoneNumberId) {
    redirect("/settings/whatsapp?from=audience-groups");
  }

  const contactsClient: Contact[] = contacts.map((c) => ({
    id: c.id,
    teamId: c.teamId,
    phoneNumber: c.phoneNumber,
    name: c.name,
    avatarUrl: c.avatarUrl ?? undefined,
    email: c.email ?? undefined,
    location: c.location ?? undefined,
    customFields: normalizeCustomFields(c.customFields),
    source: c.source as Contact["source"],
    tagIds: c.tags.map((t) => t.id),
  }));

  return <GroupForm contacts={contactsClient} tags={tags} />;
}

function normalizeCustomFields(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
