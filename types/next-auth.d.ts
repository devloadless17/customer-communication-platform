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
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: string;
    teamId: string;
    role: Role;
  }
}
