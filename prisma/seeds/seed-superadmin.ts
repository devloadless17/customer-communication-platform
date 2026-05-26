import { existsSync } from "node:fs";

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";

// `tsx` doesn't auto-load .env. In the docker container DATABASE_URL is
// injected at runtime so loading would no-op; on the host, the seed npm
// scripts expect to read it out of .env.
if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

// Superadmin bootstrap credentials. Hardcoded by choice (single-operator
// pilot). The deploy runs this on every push as an idempotent upsert, so the
// row is always present + re-asserted. Change after first login.
const email = "ali@loadless.ai";
const password = "loadless";
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

// Pilot team id — the seed only ever touches this id. If a future deploy
// shares this DB with a real customer team (cuid id), running the seed there
// would silently create an orphan "Loadless" team + a default-password
// superAdmin account on their DB. The guard below refuses to run when ANY
// non-pilot team is present, so this script becomes a safe no-op the moment
// you onboard a second tenant on the same Postgres.
const PILOT_TEAM_ID = "team_1";

async function main() {
  // Safety gate: if a team exists that isn't the pilot, bail. Idempotent +
  // visible: the message tells the operator exactly what to do (run the seed
  // against the pilot's DB only).
  const otherTeam = await db.team.findFirst({
    where: { id: { not: PILOT_TEAM_ID } },
    select: { id: true, name: true },
  });
  if (otherTeam) {
    console.warn(
      `✗ seed-superadmin refused: a non-pilot team is present in this DB ` +
        `(id=${otherTeam.id}, name=${JSON.stringify(otherTeam.name)}). ` +
        `Skipping — this DB is no longer the single-tenant pilot. Run the ` +
        `seed only against the pilot operator's own database.`,
    );
    return;
  }

  const team = await db.team.upsert({
    where: { id: PILOT_TEAM_ID },
    create: { id: PILOT_TEAM_ID, name: "Loadless" },
    update: {},
  });

  const passwordHash = await bcrypt.hash(password, 10);

  const user = await db.user.upsert({
    where: { email: email },
    create: {
      teamId: team.id,
      role: "superAdmin",
      name: NAME,
      email,
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
    where: { providerId_accountId: { providerId: "credential", accountId: email } },
    create: {
      userId: user.id,
      providerId: "credential",
      accountId: email,
      password: passwordHash,
    },
    update: { password: passwordHash, userId: user.id },
  });

  // Default #general channel. The schema documents this as auto-created at
  // team setup, and /team redirects to it on first login; without this row
  // the team-chat surface lands on the "No channels yet" dead-end.
  const channel = await db.teamChannel.upsert({
    where: { teamId_name: { teamId: team.id, name: "general" } },
    create: { teamId: team.id, name: "general", isDefault: true, createdById: user.id },
    update: {},
  });

  // Auto-add the superadmin to #general. The schema documents the default
  // channel as "implicitly including every team member" — but that invariant
  // is enforced at INSERT time (registration + invite-accept). The seed has
  // to mirror that or /team/[channelId] loops via the channels-list-membership
  // check in team-chat-workspace.tsx. (Mirrors register.controller.ts:79.)
  await db.teamChannelMember.upsert({
    where: { channelId_userId: { channelId: channel.id, userId: user.id } },
    create: { channelId: channel.id, userId: user.id, addedById: user.id },
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

  // Never log the password — this runs in CI/deploy output.
  console.log(`✓ superAdmin ready: ${user.email}`);
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
