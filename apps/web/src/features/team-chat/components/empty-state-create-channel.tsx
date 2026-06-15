"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";

import { NewChannelDialog } from "./channel-dialogs";

/**
 * Primary CTA for the zero-channel empty state (/team). Reuses the SAME
 * `NewChannelDialog` the sidebar `+` icon opens — no duplicated create form.
 * Only rendered when the viewer can create a channel; the page keeps the
 * "ask an admin" copy for everyone else.
 */
export function EmptyStateCreateChannel() {
  const router = useRouter();
  const [showNew, setShowNew] = useState(false);

  return (
    <>
      <Button onClick={() => setShowNew(true)} className="gap-2">
        <Plus className="size-4" />
        Create channel
      </Button>
      {showNew && (
        <NewChannelDialog
          onClose={() => setShowNew(false)}
          onCreated={(ch) => {
            setShowNew(false);
            router.push(`/team/${ch.id}`);
          }}
        />
      )}
    </>
  );
}
