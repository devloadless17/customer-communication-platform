import { Inbox as InboxIcon } from "lucide-react";

export default function InboxEmptyState() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <div className="flex size-12 items-center justify-center rounded-2xl border border-border bg-muted text-muted-foreground">
          <InboxIcon className="size-5" />
        </div>
        <div className="space-y-1">
          <h2 className="text-base font-medium">No conversation selected</h2>
          <p className="text-sm text-muted-foreground">
            Pick a conversation from the list to start replying. Your team's most recent
            customer threads are sorted by activity.
          </p>
        </div>
      </div>
    </div>
  );
}
