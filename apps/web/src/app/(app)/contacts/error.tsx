"use client";

import { SegmentError } from "@/components/loading/segment-error";

export default function ContactsError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <SegmentError {...props} segmentLabel="Contacts" />;
}
