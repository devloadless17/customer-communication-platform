import type { ConversationStatus } from "@ccp/shared/types";

/**
 * Single source of truth for the optimistic status side-effect of an ASSIGNMENT
 * change. MUST mirror the server rule in
 * `apps/api/src/lib/conversations/mutations.ts:assignConversation` (the
 * `nextStatus` computation, ~line 153) — the optimistic UI predicts what the
 * server will do so the header/panel/list flip instantly, then converge on the
 * authoritative `conversation.status_changed` frame.
 *
 * The rule (locked decision — see memory `project_assignment_status_rules`):
 * **assignment NEVER sets `open`; only the assignee chatting does.**
 *   - assign (user)  + `closed`  → `pending`  (reopen into triage, assigned)
 *   - assign (user)  + `pending` → unchanged  (stays pending)
 *   - assign (user)  + `open`    → unchanged  (stays open)
 *   - unassign (null)+ `open`    → `pending`  (back to triage)
 *   - everything else            → unchanged
 *
 * Both the thread-header AssignmentDropdown and the contact-panel assignee
 * picker call THIS — do not re-implement inline (a divergent copy in
 * contact-panel previously resurrected the removed `assign → open` rule,
 * producing a phantom "Open" badge + a false activity pill no server frame ever
 * corrected). Keep it single-sourced.
 */
export function predictAssignmentStatus(
  current: ConversationStatus,
  nextAssignedUserId: string | null,
): ConversationStatus {
  if (nextAssignedUserId !== null && current === "closed") return "pending";
  if (nextAssignedUserId === null && current === "open") return "pending";
  return current;
}
