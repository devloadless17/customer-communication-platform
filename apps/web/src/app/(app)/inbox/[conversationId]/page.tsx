import { redirect } from "next/navigation";

/**
 * Legacy URL shape. The inbox is now a single-page workspace driven by
 * `?c=<id>`; this route redirects so bookmarked / shared `/inbox/<id>` links
 * keep working. Uses Next's default `redirect()` which is a 307 (or 302 for
 * non-GET) — temporary by design, so browsers/CDNs don't pin the redirect
 * if the URL shape changes again.
 */
export default async function LegacyConversationRedirect({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  const { conversationId } = await params;
  redirect(`/inbox?c=${encodeURIComponent(conversationId)}`);
}
