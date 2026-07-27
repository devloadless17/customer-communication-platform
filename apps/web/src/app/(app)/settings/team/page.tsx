import { permanentRedirect } from "next/navigation";

/**
 * Legacy URL. This page rendered the WORKSPACE member roster while being
 * called "team" — and in this product a "team" is a specific, different thing:
 * a soft grouping INSIDE a workspace (`AssignmentPolicy` — Sales vs Support
 * sharing one inbox). Naming the workspace's member list after it made the two
 * concepts read as one.
 *
 * Renamed to `/settings/members`, which is literally what the page shows. This
 * redirect keeps existing bookmarks and any link in a sent email working; it
 * costs one file and can be deleted once those have aged out.
 */
export default function LegacyTeamSettingsRedirect(): never {
  permanentRedirect("/settings/members");
}
