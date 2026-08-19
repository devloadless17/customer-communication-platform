import Link from "next/link";
import { ArrowLeft, Ticket as TicketIcon } from "lucide-react";

/**
 * Rendered when the ticket id in the URL isn't reachable from the ACTIVE
 * workspace. The by-far most common way to land here is a stale link after a
 * workspace switch: a ticket is ONE row owned by one workspace, and a sibling
 * workspace reaches it only while it holds a share — same id, same number, so
 * the fix is to switch back (or open the board here) rather than hunt for a
 * copy. Say that, instead of Next's bare 404 that reads like the ticket was
 * lost.
 */
export default function TicketNotFound() {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center gap-3 px-6 py-24 text-center">
      <div className="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <TicketIcon aria-hidden className="size-5" />
      </div>
      <h1 className="text-sm font-semibold">No ticket with this id here</h1>
      <p className="text-2xs leading-relaxed text-muted-foreground">
        A ticket is one row, owned by one workspace and reachable from another only
        while that workspace holds a share. If you just switched workspaces, this link
        belonged to the previous one — open the board to find it here, or switch back.
      </p>
      <Link
        href="/tickets"
        className="mt-1 inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs font-medium transition-colors hover:bg-accent"
      >
        <ArrowLeft aria-hidden className="size-3.5" />
        Back to the board
      </Link>
    </div>
  );
}
