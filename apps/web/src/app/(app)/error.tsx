"use client";

import { SegmentError } from "@/components/loading/segment-error";

/**
 * Catch-all for the authenticated shell. Without this, a throw inside the
 * (app)/layout's shared Promise.all (getSession / getCurrentTeam) propagates
 * to the root `global-error.tsx` and renders the blank "reload to recover"
 * fallback. With this, the navigation chrome rerenders alongside a
 * recoverable error pane.
 */
export default function AppShellError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <SegmentError {...props} segmentLabel="App" />;
}
