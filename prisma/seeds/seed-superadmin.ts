import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";

const EMAIL = "ali@loadless.ai";
const PASSWORD = "loadless";
const NAME = "Ali";

// Pass the connection string directly instead of a pre-built `pg.Pool`. The
// runtime image has two `pg` installs (one under /app from the Next.js
// standalone trace, one under /opt/cli-tools transitively via @prisma/
// adapter-pg). A Pool built from /app/node_modules/pg fails the adapter's
// `instanceof Pool` check (the adapter holds the /opt-side class), so the
// Pool object gets treated as a config dict and pg falls back to
// 127.0.0.1:5432. Giving the adapter a string sidesteps both copies.
const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

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

  // Three lifecycle stages — same set the registration flow
  // (apps/api/src/registration/register.controller.ts) seeds for every new
  // team. Without these, /settings/stages renders an empty pipeline and the
  // inbox sidebar's "by stage" section is blank until the first inbound
  // message triggers `ensureDefaultStage` to lazily create a single "Stage 1".
  const stages = [
    { name: "Stage 1", color: "lime", position: 0, isDefault: true },
    { name: "Stage 2", color: "amber", position: 1, isDefault: false },
    { name: "Stage 3", color: "emerald", position: 2, isDefault: false },
  ];
  for (const s of stages) {
    await db.contactStage.upsert({
      where: { teamId_name: { teamId: team.id, name: s.name } },
      create: {
        teamId: team.id,
        name: s.name,
        color: s.color,
        position: s.position,
        isDefault: s.isDefault,
      },
      update: {},
    });
  }

  console.log(`✓ superAdmin ready: ${user.email} / ${PASSWORD}`);
}

main()
  .then(async () => {
    await db.$disconnect();
  })
  .catch(async (err) => {
    console.error(err);
    await db.$disconnect();
    process.exit(1);
  });
