import Link from "next/link";
import { ArrowLeft, Ticket as TicketIcon } from "lucide-react";

/**
 * Rendered when the ticket id in the URL doesn't exist in the ACTIVE
 * workspace. The by-far most common way to land here is a stale link after a
 * workspace switch — tickets never leave their workspace, so an id from the
 * previous workspace legitimately 404s in this one (an escalated pair is TWO
 * tickets with two different ids). Say that, instead of Next's bare 404 that
 * reads like the ticket was lost.
 */
export default function TicketNotFound() {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center gap-3 px-6 py-24 text-center">
      <div className="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <TicketIcon aria-hidden className="size-5" />
      </div>
      <h1 className="text-sm font-semibold">No ticket with this id here</h1>
      <p className="text-2xs leading-relaxed text-muted-foreground">
        Tickets live inside one workspace. If you just switched workspaces, this link
        belonged to the previous one — an escalated ticket has its own twin (and its own
        number) on each side. Open the board to find it here, or switch back.
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
