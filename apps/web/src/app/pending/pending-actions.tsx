"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Client island for the /pending screen.
 *
 *  - Auto-refresh: re-runs the page's server component every 25s. The moment a
 *    superAdmin flips the org to `active`, that re-render reads the fresh
 *    `orgStatus` and server-redirects to /settings/whatsapp — no manual reload.
 *  - "Check now": same refresh on demand (with a brief spinner) so an impatient
 *    operator isn't stuck waiting for the tick.
 *  - "Sign out": plain navigation to /logout (a route handler that CAN clear
 *    the session cookie — a server component can't), which then lands on /login.
 */
export function PendingActions() {
  const router = useRouter();
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    const id = setInterval(() => router.refresh(), 25_000);
    return () => clearInterval(id);
  }, [router]);

  function checkNow() {
    setChecking(true);
    router.refresh();
    // The refresh either redirects (approved) or re-renders this same screen.
    // Either way, clear the spinner shortly after so the button is reusable.
    setTimeout(() => setChecking(false), 1_200);
  }

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
      <Button type="button" variant="outline" onClick={checkNow} disabled={checking}>
        <RefreshCw className={checking ? "size-4 animate-spin" : "size-4"} />
        Check now
      </Button>
      <Button asChild variant="ghost">
        <a href="/logout">
          <LogOut className="size-4" />
          Sign out
        </a>
      </Button>
    </div>
  );
}
