"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";

import { NewChannelDialog } from "./channel-dialogs";
import type { Role } from "@ccp/shared/types";

/**
 * Primary CTA for the zero-channel empty state (/team). Reuses the SAME
 * `NewChannelDialog` the sidebar `+` icon opens — no duplicated create form.
 * Anyone can create a PUBLIC channel; the dialog gates the private option
 * by role and the server re-checks.
 */
export function EmptyStateCreateChannel({ currentRole }: { currentRole: Role }) {
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
          currentRole={currentRole}
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
