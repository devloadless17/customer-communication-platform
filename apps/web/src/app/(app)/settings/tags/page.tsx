import { redirect } from "next/navigation";

import { getSession } from "@/lib/auth/current-user";
import { getTagUsage, listTags } from "@/lib/api/queries";

import { TagsSettings } from "@/features/settings/components/tags-settings";

export const metadata = { title: "Tags · Settings" };
export const dynamic = "force-dynamic";

/**
 * Tag catalog manager.
 *
 * Tags are team-shared segmentation labels. Removing a tag from a contact's
 * chip set is just an M2M unlink — the tag itself sticks around until someone
 * deletes it here. The MANAGEMENT page is gated by the admin-configurable
 * `tags:manage` capability (default true for manager + agent, so today's
 * behavior is unchanged until an admin restricts it). Mirrors the stages /
 * contact-fields settings pages. Redirect to /account when gated.
 *
 * The page ships the live contact-count per tag so the admin knows what
 * they're nuking before they confirm a delete.
 */
export default async function TagsSettingsPage() {
  const { permissions } = await getSession();
  if (!permissions["tags:manage"]) {
    redirect("/account");
  }

  const [tags, usage] = await Promise.all([listTags(), getTagUsage()]);
  return <TagsSettings initialTags={tags} initialUsage={usage} />;
}
