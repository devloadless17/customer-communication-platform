import { getSession } from "@/lib/auth/current-user";
import { db } from "@/lib/db";
import type { Tag, TagColor } from "@/lib/types";

import { TagsSettings } from "./tags-settings";

export const metadata = { title: "Tags · Settings" };
export const dynamic = "force-dynamic";

/**
 * Tag catalog manager.
 *
 * Tags are team-shared segmentation labels. Removing a tag from a contact's
 * chip set is just an M2M unlink — the tag itself sticks around until an
 * admin deletes it here. Anyone signed in can manage the catalog (matching
 * the API's `requireSession` gate); future role gating belongs in
 * lib/auth/permissions, not on this page.
 *
 * The page ships the live contact-count per tag so the admin knows what
 * they're nuking before they confirm a delete.
 */
export default async function TagsSettingsPage() {
  const { teamId } = await getSession();

  const rows = await db.tag.findMany({
    where: { teamId },
    orderBy: { name: "asc" },
    include: { _count: { select: { contacts: true } } },
  });

  const tags: Tag[] = rows.map((r) => ({
    id: r.id,
    teamId: r.teamId,
    name: r.name,
    color: r.color as TagColor,
  }));
  const usageById: Record<string, number> = {};
  for (const r of rows) usageById[r.id] = r._count.contacts;

  return <TagsSettings initialTags={tags} initialUsage={usageById} />;
}
