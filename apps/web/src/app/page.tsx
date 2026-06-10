import { redirect } from "next/navigation";

import { getSession } from "@/lib/auth/current-user";

/**
 * Post-auth router. `/` resolves the session (bouncing to /logout → /login when
 * unauthenticated) and sends each role to its home:
 *   - super-admins → the platform shell (/platform)
 *   - a non-active org → the approval gate (/pending)
 *   - everyone else → the inbox
 * Keeps the login `next=/inbox` default working for normal users while routing
 * super-admins + locked-out orgs without an extra (app)-layout bounce.
 */
export default async function HomePage() {
  const { user, teamStatus } = await getSession();
  if (user.role === "superAdmin") redirect("/platform");
  if (teamStatus !== "active") redirect("/pending");
  redirect("/inbox");
}
