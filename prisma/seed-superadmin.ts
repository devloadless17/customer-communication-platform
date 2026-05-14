import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const EMAIL = "ali@loadless.ai";
const PASSWORD = "loadless";
const NAME = "Ali";

const db = new PrismaClient();

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
      passwordHash,
    },
    update: {
      role: "superAdmin",
      name: NAME,
      passwordHash,
      deactivatedAt: null,
    },
  });

  console.log(`✓ superAdmin ready: ${user.email} / ${PASSWORD}`);
}

main()
  .then(() => db.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await db.$disconnect();
    process.exit(1);
  });
