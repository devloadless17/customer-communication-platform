import { RouteShellSkeleton } from "@/components/loading/route-shell";

/**
 * /team — covers /team and /team/[channelId] (Next.js propagates this
 * loading state to all child segments). Reuses the shared route-shell
 * skeleton so all top-level segments feel consistent during navigation.
 */
export default function Loading() {
  return <RouteShellSkeleton bodyLines={8} />;
}
