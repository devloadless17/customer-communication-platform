import { RouteShellSkeleton } from "@/components/loading/route-shell";

/**
 * /workflows — covers /workflows, /workflows/new, /workflows/[id]
 * (Next.js propagates loading state down child segments).
 *
 * `withSidebarRail={false}`: this skeleton renders inside SectionShell's
 * <main>, which already sits to the right of the real AppRail — drawing the
 * rail again would flash a phantom second column on every Workflows entry.
 */
export default function Loading() {
  return <RouteShellSkeleton withSidebarRail={false} bodyLines={6} />;
}
