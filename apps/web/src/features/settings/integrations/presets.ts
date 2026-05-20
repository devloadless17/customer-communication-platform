import type { ApiKeyScope } from "@ccp/shared/api-keys/scopes";

/**
 * Per-integration defaults for the one-click "Connect" flow on the
 * integrations page. The connect flow hits `/api/team/api-keys` with a
 * preset-derived name + a least-privilege scope set tailored to what
 * the integration actually calls.
 *
 * Why least-privilege over `["*"]`: if the partner's key leaks, the
 * blast radius is bounded by the scopes we pre-selected.
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
  /**
   * Copy-paste-ready curl starters rendered in the connect panel. The
   * panel substitutes the actual token when one was just generated (and
   * is still on screen); otherwise renders `$CCP_TOKEN` as a placeholder
   * the user can set in their shell.
   */
  curlExamples: CurlExample[];
}

export interface CurlExample {
  id: string;
  label: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** Path-only, e.g. `/api/external/v1/contacts/upsert`. */
  path: string;
  /** Optional JSON request body. Sent compact-stringified in `-d`. */
  body?: Record<string, unknown>;
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
  curlExamples: [
    {
      id: "list-tags",
      label: "Test the key (list tags)",
      method: "GET",
      path: "/api/external/v1/tags",
    },
    {
      id: "upsert-contact",
      label: "Create or update a contact",
      method: "POST",
      path: "/api/external/v1/contacts/upsert",
      body: { phoneNumber: "+15555550100", name: "Jane Doe" },
    },
    {
      id: "send-message",
      label: "Send a WhatsApp message",
      method: "POST",
      path: "/api/external/v1/messages",
      body: { contact: { phone: "+15555550100" }, text: "Hello from n8n" },
    },
  ],
};
