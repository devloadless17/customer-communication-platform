import "server-only";



import { api } from "../../api-client";
import type {
  Role,
} from "@ccp/shared/types";

/**
 * Inline DTOs that the API ships but apps/api defines locally in its
 * service files. Kept here (not in @ccp/shared) because the source-of-truth
 * lives next to the controller; this is just the consumer-side mirror so
 * web pages can name the response shape.
 */
// Invites
// ---------------------------------------------------------------------------

export interface InviteListDto {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
  createdAt: string;
  createdByName: string;
}

export async function listInvites(): Promise<InviteListDto[]> {
  const { invites } = await api<{ invites: InviteListDto[] }>("/api/invites");
  return invites;
}

export interface InviteLookupResult {
  status: "valid" | "invalid" | "used" | "expired";
  invite: { email: string; role: Role; teamName: string } | null;
}

export async function lookupInvite(token: string): Promise<InviteLookupResult> {
  // Public endpoint — but still routed through api() so the cookie
  // forward + x-forwarded-for stay consistent. 401 won't fire here.
  return api<InviteLookupResult>(`/api/invites/lookup/${encodeURIComponent(token)}`, {
    on401: "throw",
  });
}

// ---------------------------------------------------------------------------
