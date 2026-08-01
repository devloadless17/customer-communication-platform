/**
 * One thing that happened which ONE person should know about.
 *
 * Rendered by the bell. Every field the line needs is ON the notification —
 * the ticket number, the subject, the actor's name — because a notification is
 * a statement about a MOMENT ("Sara assigned you #42"), the same reason
 * `TicketEvent.after` snapshots rather than joins. It keeps reading correctly
 * after a rename, and after the actor leaves the organization.
 */
export interface AppNotification {
  id: string;
  /**
   * `ticket_assigned` | `ticket_replied` | `ticket_changed` |
   * `ticket_file_added` | `ticket_escalated`.
   *
   * A string, not a union, on purpose: a client from an older build renders an
   * unknown kind as a generic line instead of failing the whole bell.
   */
  kind: string;
  ticketId: string | null;
  ticketNumber: number | null;
  ticketSubject: string | null;
  actorUserId: string | null;
  /** Null for automation — the UI says "Automation". */
  actorName: string | null;
  /** One human line: "changed the status to Solved". */
  summary: string | null;
  /** ISO, or null while unread. */
  readAt: string | null;
  /** ISO. */
  createdAt: string;
}
