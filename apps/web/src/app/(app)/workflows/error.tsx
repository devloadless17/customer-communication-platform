"use client";

import { SegmentError } from "@/components/loading/segment-error";

export default function WorkflowsError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <SegmentError {...props} segmentLabel="Workflows" />;
}
