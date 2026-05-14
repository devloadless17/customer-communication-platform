import type { User } from "@/lib/types";

export function unknownAuthor(id: string): User {
  return {
    id,
    teamId: "",
    role: "agent",
    name: "Unknown",
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
