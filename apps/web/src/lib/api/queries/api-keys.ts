import "server-only";



import { api } from "../../api-client";

/**
 * Inline DTOs that the API ships but apps/api defines locally in its
 * service files. Kept here (not in @ccp/shared) because the source-of-truth
 * lives next to the controller; this is just the consumer-side mirror so
 * web pages can name the response shape.
 */
// API keys
// ---------------------------------------------------------------------------

export interface ApiKeyListItem {
  id: string;
  name: string;
  tokenPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  scopes: string[];
}

export async function listApiKeys(): Promise<ApiKeyListItem[]> {
  const { keys } = await api<{ keys: ApiKeyListItem[] }>("/api/workspace/api-keys");
  return keys;
}

// ---------------------------------------------------------------------------
