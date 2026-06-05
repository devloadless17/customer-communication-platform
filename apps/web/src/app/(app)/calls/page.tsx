import { redirect } from "next/navigation";

import { getSession } from "@/lib/auth/current-user";

import { CallsHistory } from "./calls-history";

export const metadata = { title: "Calls" };
export const dynamic = "force-dynamic";

/**
 * Team-wide call history — everything related to customer voice calls in one
 * place. Gated on the calling capabilities (default true for every role; an
 * admin can scope it out via Role permissions). Recordings/playback are NOT
 * available: WhatsApp Cloud calls are end-to-end + peer-to-peer, so the audio
 * never reaches our server (the recording columns were dropped on purpose).
 */
export default async function CallsPage() {
  const { permissions } = await getSession();
  if (!permissions["calls:make"] && !permissions["calls:receive"]) {
    redirect("/inbox");
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 md:px-8">
        <CallsHistory canCall={!!permissions["calls:make"]} />
      </div>
    </div>
  );
}
