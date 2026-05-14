/**
 * Idempotent superAdmin bootstrap. Runs on every container start (Dockerfile
 * CMD) after `prisma migrate deploy` and before the server boots.
 *
 * Source of truth = GitHub Secrets (rendered into /root/.env on the VPS, then
 * exposed to the container via docker-compose):
 *
 *   SUPER_ADMIN_EMAIL     (required)
 *   SUPER_ADMIN_PASSWORD  (required)
 *   SUPER_ADMIN_NAME      (optional — defaults to email's local part)
 *
 * Behavior:
 *   - If env vars are missing, skip silently (exit 0). Local dev uses
 *     `db:seed` instead; only production needs this guarantee.
 *   - Upserts a single Team (id "team_1") so the user has a foreign-key
 *     target. If the team already exists with a different id, we attach to
 *     whatever team already exists.
 *   - Upserts the user by email. role is forced to superAdmin, name is
 *     refreshed, passwordHash is re-hashed and overwritten on every deploy.
 *     This means rotating SUPER_ADMIN_PASSWORD in GitHub Secrets and
 *     redeploying actually rotates the live password — predictable.
 *     Side effect: changing the password from inside the UI will be reset
 *     by the next deploy. That's the trade-off for declarative secrets.
 */

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const db = new PrismaClient();

async function main() {
  const email = process.env.SUPER_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SUPER_ADMIN_PASSWORD;
  const name =
    process.env.SUPER_ADMIN_NAME?.trim() || email?.split("@")[0] || "Admin";

  if (!email || !password) {
    console.log(
      "[bootstrap-admin] SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD not set — skipping.",
    );
    return;
  }

  // Find or create the first team. Hardcoded id keeps re-runs idempotent and
  // matches the dev seed's "team_1".
  const existingTeam = await db.team.findFirst({ orderBy: { createdAt: "asc" } });
  const team =
    existingTeam ??
    (await db.team.create({
      data: { id: "team_1", name: "Loadless" },
    }));

  const passwordHash = await bcrypt.hash(password, 10);

  const user = await db.user.upsert({
    where: { email },
    create: {
      teamId: team.id,
      role: "superAdmin",
      name,
      email,
      passwordHash,
    },
    update: {
      role: "superAdmin",
      name,
      passwordHash,
      deactivatedAt: null,
    },
  });

  console.log(`[bootstrap-admin] ✓ superAdmin upserted: ${user.email}`);
}

main()
  .then(async () => {
    await db.$disconnect();
  })
  .catch(async (err) => {
    console.error("[bootstrap-admin] failed:", err);
    await db.$disconnect();
    // Hard-fail so a broken bootstrap doesn't silently leave production
    // with no way to log in. Container will crash-loop until env is fixed.
    process.exit(1);
  });
