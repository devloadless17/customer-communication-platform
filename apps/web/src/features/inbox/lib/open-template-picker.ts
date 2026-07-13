/**
 * Cross-component signal: "open the WhatsApp template picker for this thread".
 *
 * The full template flow (load + sync + variable-fill + `POST /api/messages/
 * template`) lives in the composer (`reply-box.tsx`), which already renders the
 * `TemplatePicker` and owns every prop it needs (contact, current user, stage
 * catalog, tags, field definitions). Re-wiring all of that into the contact
 * panel would duplicate a lot of state for one button, so instead the contact-
 * panel "Send template" button fires this signal and the composer — mounted for
 * the same open thread — opens its existing picker.
 *
 * Same one-owner pub/sub shape as `optimistic-list-bump`: exactly one subscriber
 * (the composer for the displayed thread). The `conversationId` guard makes it a
 * no-op for any other mounted composer (there is only ever one, but the guard
 * keeps it correct if that changes).
 */

type Listener = (conversationId: string) => void;

const listeners = new Set<Listener>();

/** Subscribe (the composer). Returns an unsubscribe fn for effect cleanup. */
export function onOpenTemplatePicker(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Fire from the contact-panel button to open the composer's template picker. */
export function emitOpenTemplatePicker(conversationId: string): void {
  for (const cb of [...listeners]) {
    try {
      cb(conversationId);
    } catch (err) {
      console.error("[open-template-picker] subscriber threw", err);
    }
  }
}
