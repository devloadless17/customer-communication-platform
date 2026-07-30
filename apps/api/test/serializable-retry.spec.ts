/**
 * `runWithSerializableRetry` — the retry that wasn't retrying.
 *
 * Ingest wraps its check-then-act writes in a Serializable transaction, which is
 * what makes one-conversation-per-contact hold when ten messages from the same
 * customer land together. Serializable's price is conflicts, and the whole point
 * of this helper is to absorb them locally instead of converting each one into a
 * 503 that makes Meta redeliver the entire batch.
 *
 * It classified retryability as `PrismaClientKnownRequestError` with P2034/P2002.
 * `@prisma/adapter-pg` raises none of those: it raises `DriverAdapterError` with
 * `cause.kind = "TransactionWriteConflict"` — no `.code`, different class, none
 * of Prisma's text. So the five-attempt backoff threw on attempt one, every time,
 * for the shape that actually arrives.
 *
 * These tests are written against the SHAPES rather than against a live race,
 * because the shape is what defeated the code twice before (see
 * `isTransientDbError`'s docblock). A test that provoked a real conflict would
 * pass just as well against the broken matcher on a fast, idle machine.
 *
 *   pnpm --filter @ccp/api exec vitest run test/serializable-retry.spec.ts
 */
import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { afterEach, describe, expect, it } from "vitest";

import { setSharedDb } from "@/lib/db";
import { runWithSerializableRetry } from "@/lib/providers/ingest";

/** The error `@prisma/adapter-pg` actually raises on a serialization conflict. */
function driverAdapterError(kind: string, message = kind): Error {
  const err = new Error(message);
  err.name = "DriverAdapterError";
  (err as unknown as { cause: unknown }).cause = { kind };
  return err;
}

/** Same conflict, but reported in `message` instead of `cause.kind` — the
 *  adapter has moved this detail between the two across releases. */
function messageOnlyConflict(message: string): Error {
  const err = new Error(message);
  err.name = "DriverAdapterError";
  return err;
}

/**
 * Install a fake db whose `$transaction` fails `failures` times, then succeeds.
 * Returns a counter of how many attempts were actually made.
 */
function installDb(failures: number, err: unknown): { attempts: () => number } {
  let attempts = 0;
  setSharedDb({
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => {
      attempts += 1;
      if (attempts <= failures) throw err;
      return work({});
    },
  } as unknown as PrismaClient);
  return { attempts: () => attempts };
}

afterEach(() => {
  // Leave no fake behind for another spec in this worker.
  setSharedDb(undefined as unknown as PrismaClient);
});

describe("runWithSerializableRetry retries the shape the adapter ACTUALLY raises", () => {
  it("retries a DriverAdapterError TransactionWriteConflict", async () => {
    // THE REGRESSION. Before the fix this threw on attempt 1 and never retried.
    const db = installDb(2, driverAdapterError("TransactionWriteConflict"));

    await expect(runWithSerializableRetry(async () => "ok")).resolves.toBe("ok");
    expect(db.attempts(), "should have retried past the first conflict").toBe(3);
  });

  it("retries when the conflict is only in the MESSAGE, with no cause.kind", async () => {
    const db = installDb(1, messageOnlyConflict("TransactionWriteConflict"));

    await expect(runWithSerializableRetry(async () => "ok")).resolves.toBe("ok");
    expect(db.attempts()).toBe(2);
  });

  it("retries a postgres 'could not serialize' sentence", async () => {
    const db = installDb(1, new Error("could not serialize access due to read/write dependencies"));

    await expect(runWithSerializableRetry(async () => "ok")).resolves.toBe("ok");
    expect(db.attempts()).toBe(2);
  });

  it("still retries the Prisma-shaped P2034 it always handled", async () => {
    const p2034 = new Prisma.PrismaClientKnownRequestError("write conflict", {
      code: "P2034",
      clientVersion: "test",
    });
    const db = installDb(1, p2034);

    await expect(runWithSerializableRetry(async () => "ok")).resolves.toBe("ok");
    expect(db.attempts()).toBe(2);
  });

  it("retries the unique-violation backstop, in both shapes", async () => {
    // The loser of a findFirst→create race can surface as a unique violation
    // rather than a serialization failure; retrying finds the winner's row.
    const p2002 = new Prisma.PrismaClientKnownRequestError("unique", {
      code: "P2002",
      clientVersion: "test",
    });
    const a = installDb(1, p2002);
    await expect(runWithSerializableRetry(async () => "ok")).resolves.toBe("ok");
    expect(a.attempts()).toBe(2);

    const b = installDb(1, driverAdapterError("UniqueConstraintViolation"));
    await expect(runWithSerializableRetry(async () => "ok")).resolves.toBe("ok");
    expect(b.attempts()).toBe(2);
  });
});

describe("it must not retry what a retry cannot fix", () => {
  it("propagates a non-race error on the FIRST attempt", async () => {
    // A bug in `work` must surface immediately, not five times slower.
    const db = installDb(99, new TypeError("cannot read properties of undefined"));

    await expect(runWithSerializableRetry(async () => "ok")).rejects.toThrow(TypeError);
    expect(db.attempts()).toBe(1);
  });

  it("does NOT retry a dead connection — that is the 503 path's job", async () => {
    // `isTransientDbError` is deliberately broader than this classifier: a dead
    // pool wants Meta to redeliver later, not a tight loop hammering it now.
    const db = installDb(99, driverAdapterError("ConnectionClosed"));

    await expect(runWithSerializableRetry(async () => "ok")).rejects.toThrow();
    expect(db.attempts()).toBe(1);
  });

  it("gives up after a bounded number of attempts and rethrows the conflict", async () => {
    // Bounded so a pathological conflict can never park a request forever; the
    // 503 + redelivery contract takes over from here.
    const db = installDb(99, driverAdapterError("TransactionWriteConflict"));

    await expect(runWithSerializableRetry(async () => "ok")).rejects.toThrow();
    expect(db.attempts()).toBeGreaterThan(1);
    expect(db.attempts()).toBeLessThanOrEqual(5);
  });
});
