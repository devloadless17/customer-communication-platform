import type { User } from "@/lib/types";

/**
 * Synthesize a placeholder user for the inbox UI in three cases:
 *   - We don't have the row in our local `memberById` map (rare race).
 *   - The note/message was authored by a teammate who has been hard-deleted
 *     (authorUserId / senderUserId is now NULL in the DB).
 *   - We want to render "Removed user" without crashing.
 */
export function unknownAuthor(id: string | null): User {
  return {
    id: id ?? "removed",
    teamId: "",
    role: "agent",
    name: id ? "Unknown" : "Removed user",
    email: "",
  };
}

/** Best-effort extract a human-readable message from a 4xx/5xx response. */
export async function readError(res: Response): Promise<string> {
  try {
    const json = (await res.json()) as { error?: string; detail?: string };
    if (json.detail) return `${json.error ?? "error"}: ${json.detail}`;
    if (json.error) return json.error;
  } catch {
    // not JSON — fall through
  }
  return `Server returned HTTP ${res.status}.`;
}
