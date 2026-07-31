import { cookies } from "next/headers";

import { getSession } from "@/lib/auth/current-user";
import { listContactFieldDefinitions, listWhatsappTemplates } from "@/lib/api/queries";

import { TemplatesView } from "@/features/templates/components/templates-view";
// Pure SSR-safe primitives (no "use client") — same split pattern as
// inbox-filter.ts / broadcasts-cookies.ts. Importing parsers / cookie
// constants from a client component crashes at runtime with
// "Attempted to call X() from the server but X is on the client."
import {
  TEMPLATES_SEARCH_COOKIE,
  TEMPLATES_STATUS_COOKIE,
  parseTemplatesStatus,
} from "@/features/templates/lib/templates-cookies";

/**
 * Templates index. Server component so the initial paint already has the
 * team's cached templates and the contact field schema (needed by the binding
 * editor inside the drawer). All further mutations go through API routes.
 *
 * The status filter + search query persist across hard refreshes via cookies
 * (templates-status, templates-search) read SSR-side and forwarded to the
 * view as initial state — first paint already shows the user's last view.
 */

export const metadata = { title: "Templates" };
export const dynamic = "force-dynamic";

export default async function TemplatesPage() {
  const [{ permissions }, templatesResp, fieldDefinitions, cookieStore] =
    await Promise.all([
      getSession(),
      listWhatsappTemplates(),
      listContactFieldDefinitions(),
      cookies(),
    ]);

  const initialStatusFilter = parseTemplatesStatus(
    cookieStore.get(TEMPLATES_STATUS_COOKIE)?.value,
  );
  // The client writes this cookie with encodeURIComponent (templates-view.tsx),
  // but cookies().get() returns the raw value — decode it here or a search with
  // a space/non-ASCII char seeds as percent-encoded text that matches nothing.
  // Same manual-decode pattern as server-tz.ts.
  const rawQuery = cookieStore.get(TEMPLATES_SEARCH_COOKIE)?.value ?? "";
  let initialQuery = rawQuery;
  try {
    initialQuery = decodeURIComponent(rawQuery);
  } catch {
    // Malformed encoding — fall back to the raw value.
  }

  return (
    <TemplatesView
      initialTemplates={templatesResp.templates}
      fieldDefinitions={fieldDefinitions}
      connected={templatesResp.connected}
      hasWabaId={templatesResp.hasWabaId}
      canManage={permissions["templates:manage"]}
      initialStatusFilter={initialStatusFilter}
      initialQuery={initialQuery}
    />
  );
}
