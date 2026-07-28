"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { PhoneIncoming } from "lucide-react";
import { toast } from "sonner";

import { getClientSocket } from "@/lib/socket-client";

/**
 * Team-wide callback-request notification. A customer who taps WhatsApp's
 * "request a callback" (offered outside call hours / when calling is off)
 * produces NO message and NO call — just a `call:permission` frame with
 * `callback_requested` — so without this toast, nobody online learns about it
 * until they happen to open the thread and see the timeline pill.
 *
 * Passive and informational (unlike IncomingCallToast there is nothing to
 * answer), so it is NOT gated on the `calls:receive` capability — a manager
 * who can't take calls still needs to know someone asked for one. Offline
 * agents catch up via the persisted pill + the thread rising in the inbox
 * list (the ingest bumps `lastMessageAt`, missed-call style).
 */
export function CallbackRequestToast() {
  const router = useRouter();

  useEffect(() => {
    const socket = getClientSocket();
    const onPermission: Parameters<typeof socket.on<"call:permission">>[1] = (
      payload,
    ) => {
      if (payload.permission !== "callback_requested") return;
      toast(`${payload.contactName ?? "A customer"} requested a callback`, {
        icon: <PhoneIncoming className="size-4" />,
        description: "They allowed calls — you can call them back now.",
        // Longer than the default: this is the only live surface for the
        // request, and there's no ring to draw the eye.
        duration: 12_000,
        action: {
          label: "Open",
          onClick: () => {
            router.push(`/inbox?c=${encodeURIComponent(payload.conversationId)}`);
          },
        },
      });
    };
    socket.on("call:permission", onPermission);
    return () => {
      socket.off("call:permission", onPermission);
    };
  }, [router]);

  return null;
}
