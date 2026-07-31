/**
 * Shape-pins for `isTransientDbError` / `isDriverTransientError` — the
 * classifier that decides whether a failed ingest event re-throws (webhook
 * 503 → Meta redelivers, dedup absorbs) or is swallowed (answered 200, gone
 * forever). It has now been defeated THREE times not by a missing condition
 * but by the error's SHAPE:
 *
 *   1. pg-pool acquisition timeout — text-only, no SQLSTATE.
 *   2. adapter-pg `DriverAdapterError` with `cause.kind` — no code, no text.
 *   3. (2026-07-31, found by the broadcast status-flood harness) statement
 *      timeout: `DriverAdapterError` carrying SQLSTATE 57014 on the NESTED
 *      `cause.code` — `{ cause: { code: "57014", severity: "ERROR", … } }` —
 *      with a bare top level. Classified permanent; a delivery status (or an
 *      inbound message) was swallowed and answered 200 on its only delivery.
 *
 * Every shape that has ever defeated it is pinned here so the fourth defeat
 * trips a test instead of losing a customer message.
 */
import { describe, expect, it } from "vitest";

import { isTransientDbError } from "@/lib/providers/ingest";

function driverAdapterError(fields: {
  message?: string;
  cause?: Record<string, unknown>;
  code?: string;
}): Error {
  const err = new Error(fields.message ?? "driver error");
  err.name = "DriverAdapterError";
  if (fields.cause) (err as unknown as { cause: unknown }).cause = fields.cause;
  if (fields.code) (err as unknown as { code: string }).code = fields.code;
  return err;
}

describe("statement timeout (SQLSTATE 57014) — the third shape defeat", () => {
  it("is transient when the SQLSTATE rides the NESTED cause.code (adapter-pg reality)", () => {
    expect(
      isTransientDbError(
        driverAdapterError({
          message: "canceling statement due to statement timeout",
          cause: {
            code: "57014",
            severity: "ERROR",
            message: "canceling statement due to statement timeout",
          },
        }),
      ),
    ).toBe(true);
  });

  it("is transient on the message text alone (adapter detail placement drifts)", () => {
    expect(
      isTransientDbError(
        driverAdapterError({ message: "canceling statement due to statement timeout" }),
      ),
    ).toBe(true);
  });

  it("is transient on a bare top-level SQLSTATE too", () => {
    expect(isTransientDbError(driverAdapterError({ message: "x", code: "57014" }))).toBe(true);
  });
});

describe("prior defeats stay pinned", () => {
  it("cause.kind TransactionWriteConflict (second defeat)", () => {
    expect(
      isTransientDbError(
        driverAdapterError({ message: "x", cause: { kind: "TransactionWriteConflict" } }),
      ),
    ).toBe(true);
  });

  it("pg-pool acquisition timeout text (first defeat)", () => {
    expect(
      isTransientDbError(new Error("timeout exceeded when trying to connect")),
    ).toBe(true);
  });
});

describe("permanent stays permanent — a retry-storm is the failure mode on this side", () => {
  it("a plain application error is not transient", () => {
    expect(isTransientDbError(new Error("invalid payload: no such contact"))).toBe(false);
  });

  it("a nested cause with a NON-transient SQLSTATE is not transient", () => {
    // 23505 unique_violation — the dedup guard doing its job, never a retry.
    expect(
      isTransientDbError(
        driverAdapterError({ message: "duplicate key", cause: { code: "23505" } }),
      ),
    ).toBe(false);
  });
});
