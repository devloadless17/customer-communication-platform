/**
 * Public channel name — the MEDIUM a conversation/message is on ("whatsapp",
 * "instagram", "telegram", …). Single source of truth for the `channel` field
 * on every public payload (outbound webhooks + the external /v1 API), so the
 * two surfaces can never drift.
 *
 * Channel ≠ provider. `meta_cloud` (the Meta Cloud API) is a PROVIDER that
 * serves BOTH WhatsApp and Instagram, so the channel canNOT be derived from
 * `provider`. Today there is exactly one channel (WhatsApp), so this is a
 * constant; when a second channel ships, store an explicit `channel` on the
 * conversation/message row and return it here (add a row param) — do NOT map
 * from `provider`, which would collapse WhatsApp and Instagram into one.
 */
export function publicChannel(): string {
  return "whatsapp";
}
