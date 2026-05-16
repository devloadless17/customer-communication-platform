import { redirect } from "next/navigation";

/**
 * Legacy URL shape. The inbox is now a single-page workspace driven by
 * `?c=<id>`; this route just permanently redirects so bookmarked / shared
 * `/inbox/<id>` links keep working.
 */
export default async function LegacyConversationRedirect({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  const { conversationId } = await params;
  redirect(`/inbox?c=${encodeURIComponent(conversationId)}`);
}
