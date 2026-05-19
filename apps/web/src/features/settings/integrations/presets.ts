import type { ApiKeyScope } from "@ccp/shared/api-keys/scopes";

/**
 * Per-integration defaults for the one-click "Connect" flow on the
 * integrations page. The same `/api/team/api-keys` endpoint backs both
 * manual creation (settings/api-keys) and these presets — the only
 * difference is that the connect flow pre-fills a sensible name + a
 * least-privilege scope set tailored to what the integration actually
 * calls.
 *
 * Why least-privilege over `["*"]`: if the partner's key leaks, the blast
 * radius is bounded by the scopes we pre-selected. Admins who want
 * something broader can still create a wildcard key manually from the
 * API keys page.
 *
 * `defaultName` is also the lookup key for "already connected" detection
 * — we match against active (non-revoked) keys by exact name. That makes
 * "Connect" idempotent in the UI: clicking it again surfaces the existing
 * key instead of silently creating a duplicate.
 */
export interface IntegrationPreset {
  key: string;
  label: string;
  defaultName: string;
  recommendedScopes: ApiKeyScope[];
}

export const N8N_PRESET: IntegrationPreset = {
  key: "n8n",
  label: "n8n",
  defaultName: "n8n",
  // Covers every /v1 endpoint the n8n docs section lists:
  //   contacts/upsert + tags        → write:contacts (+ read for lookups)
  //   conversations/:id/messages    → write:messages
  //   tags / stages reads           → read:catalog
  //   conversation list/get         → read:conversations
  //   per-conversation history      → read:messages
  recommendedScopes: [
    "read:contacts",
    "write:contacts",
    "read:conversations",
    "read:messages",
    "write:messages",
    "read:catalog",
  ],
};
