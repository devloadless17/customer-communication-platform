import "server-only";

import { db } from "@/lib/db";
import type { User } from "@/lib/types";

/**
 * Current-user stub. Phase 1 has no auth — every request acts as the seeded
 * admin in the seeded team. NextAuth lands Week 1 and replaces this.
 *
 * Anywhere the UI today asks "who am I?", it goes through here.
 */

const STUB_EMAIL = "ali@loadless.ai";

interface Session {
  user: User;
  teamId: string;
}

export async function getSession(): Promise<Session> {
  const row = await db.user.findUnique({ where: { email: STUB_EMAIL } });
  if (!row) {
    throw new Error(
      `No seeded user found for ${STUB_EMAIL}. Run \`npm run db:seed\` first.`,
    );
  }
  return {
    user: {
      id: row.id,
      teamId: row.teamId,
      role: row.role,
      name: row.name,
      email: row.email,
      avatarUrl: row.avatarUrl ?? undefined,
    },
    teamId: row.teamId,
  };
}
