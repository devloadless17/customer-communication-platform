import { RouteShellSkeleton } from "@/components/loading/route-shell";

/**
 * /workflows — covers /workflows, /workflows/new, /workflows/[id]
 * (Next.js propagates loading state down child segments).
 */
export default function Loading() {
  return <RouteShellSkeleton bodyLines={6} />;
}
