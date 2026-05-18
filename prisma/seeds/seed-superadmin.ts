import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";
import { Pool } from "pg";

const EMAIL = "ali@loadless.ai";
const PASSWORD = "loadless";
const NAME = "Ali";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  const team = await db.team.upsert({
    where: { id: "team_1" },
    create: { id: "team_1", name: "Loadless" },
    update: {},
  });

  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  const user = await db.user.upsert({
    where: { email: EMAIL },
    create: {
      teamId: team.id,
      role: "superAdmin",
      name: NAME,
      email: EMAIL,
    },
    update: {
      role: "superAdmin",
      name: NAME,
      deactivatedAt: null,
    },
  });

  // Better Auth verifies credentials against Account.password (providerId
  // "credential", accountId = email). Mirror the hash here so signin works on
  // a freshly-seeded DB — the old per-migration backfill is gone after the
  // init-migration squash.
  await db.account.upsert({
    where: { providerId_accountId: { providerId: "credential", accountId: EMAIL } },
    create: {
      userId: user.id,
      providerId: "credential",
      accountId: EMAIL,
      password: passwordHash,
    },
    update: { password: passwordHash, userId: user.id },
  });

  // Default #general channel. The schema documents this as auto-created at
  // team setup, and /team redirects to it on first login; without this row
  // the team-chat surface lands on the "No channels yet" dead-end.
  await db.teamChannel.upsert({
    where: { teamId_name: { teamId: team.id, name: "general" } },
    create: { teamId: team.id, name: "general", isDefault: true, createdById: user.id },
    update: {},
  });

  console.log(`✓ superAdmin ready: ${user.email} / ${PASSWORD}`);
}

main()
  .then(async () => {
    await db.$disconnect();
    await pool.end();
  })
  .catch(async (err) => {
    console.error(err);
    await db.$disconnect();
    await pool.end();
    process.exit(1);
  });
