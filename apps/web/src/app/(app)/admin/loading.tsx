import { RouteShellSkeleton } from "@/components/loading/route-shell";

/**
 * /admin (super-admin only). The layout blocks on a session + role check and
 * the page fetches cross-team data, so without a skeleton the prior page
 * freezes until those awaits resolve. `withSidebarRail={false}` because this
 * renders inside the already-mounted AppRail shell.
 */
export default function Loading() {
  return <RouteShellSkeleton withSidebarRail={false} bodyLines={6} />;
}
