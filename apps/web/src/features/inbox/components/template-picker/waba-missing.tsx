"use client";

import { Settings as SettingsIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

export function WabaMissingState() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <div className="inline-flex size-10 items-center justify-center rounded-full bg-warning-bg text-warning-fg">
        <SettingsIcon className="size-5" />
      </div>
      <div className="text-sm font-medium">WhatsApp Business Account ID needed</div>
      <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
        Templates live on your WABA, not your phone number. Paste your WABA ID
        in Settings → WhatsApp to load and send approved templates.
      </p>
      <Button asChild variant="outline" size="sm" className="mt-1 h-8">
        <a href="/settings/whatsapp">Open settings</a>
      </Button>
    </div>
  );
}
