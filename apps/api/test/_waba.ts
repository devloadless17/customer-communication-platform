/**
 * Test helper: seed a `WhatsappBusinessAccount` and get its id.
 *
 * The WABA is a first-class row (Meta's hierarchy is business portfolio → WABA →
 * business phone number), so a fixture that used to write `wabaId: "waba_a"` onto a
 * connection now needs the row to exist first and points at it by FK.
 *
 * `externalWabaId` is GLOBALLY unique — that index is the tenancy guard, since Meta
 * delivers a WABA's webhooks to whichever app is subscribed — so this upserts
 * rather than creates. Fixtures must therefore use per-suite-unique WABA ids (they
 * already do, via the `S` timestamp prefix), or two suites running against the same
 * dev database would fight over one row.
 */
import type { PrismaClient } from "@prisma/client";

export async function seedWabaAccount(
  prisma: Pick<PrismaClient, "whatsappBusinessAccount">,
  workspaceId: string,
  externalWabaId: string,
  opts: { portfolioId?: string | null } = {},
): Promise<string> {
  const row = await prisma.whatsappBusinessAccount.upsert({
    where: { externalWabaId },
    create: {
      workspaceId,
      externalWabaId,
      ...(opts.portfolioId ? { portfolioId: opts.portfolioId } : {}),
    },
    update: {
      ...(opts.portfolioId ? { portfolioId: opts.portfolioId } : {}),
    },
    select: { id: true },
  });
  return row.id;
}
