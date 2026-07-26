import { canaryFingerprint, readFingerprint, FINGERPRINT_FILE } from "./_helpers/canary";
import { db } from "./_helpers/db";

/**
 * Global teardown: the isolation canary must be byte-identical to what the
 * setup fingerprinted. Any drift means a spec or helper wrote OUTSIDE the
 * `e2e-` namespace — the exact accident class (unfiltered deleteMany against
 * the shared dev DB) this guards against. Fail the whole run loudly.
 */
export default async function verifyCanary(): Promise<void> {
  const expected = readFingerprint();
  if (!expected) {
    // Setup never ran (e.g. `--project` filtered it out) — nothing to verify.
    return;
  }
  const actual = await canaryFingerprint();
  await db().$disconnect();
  if (actual !== expected) {
    throw new Error(
      "ISOLATION CANARY TRIPPED: the canary tenant changed during this run. " +
        "A spec or helper wrote outside the e2e- namespace — find it before " +
        `trusting any cleanup code. (fingerprints: ${FINGERPRINT_FILE})`,
    );
  }
}
