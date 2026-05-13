import type { DefaultSession } from "next-auth";
import type { Role } from "@/lib/types";

// Augment NextAuth's session/user/JWT shapes so our domain fields are typed
// throughout the app — `session.user.teamId` is a real string, not `any`.

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      teamId: string;
      role: Role;
    } & DefaultSession["user"];
  }

  interface User {
    teamId: string;
    role: Role;
    // In-memory only — set in authorize() so the jwt callback can pick the
    // session length. Never persisted on the user row.
    remember?: boolean;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: string;
    teamId: string;
    role: Role;
    // Session-lifetime bookkeeping. Set on first sign-in; checked on every
    // subsequent request to enforce idle + absolute timeouts.
    remember?: boolean;
    /** Absolute expiry in ms-since-epoch. Token is dead after this regardless of activity. */
    absoluteExp?: number;
    /** Last time the jwt callback saw a request, in ms-since-epoch. Drives idle expiry. */
    lastActive?: number;
    /** Set when the session has expired (idle or absolute) so session() can null it out. */
    expired?: boolean;
  }
}
