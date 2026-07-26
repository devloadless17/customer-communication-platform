import { test as setup } from "@playwright/test";

import { ensureCanary, canaryFingerprint, writeFingerprint } from "./_helpers/canary";

/**
 * Plant + fingerprint the isolation canary BEFORE any spec runs. The paired
 * global teardown (isolation-canary.teardown.ts) re-fingerprints after the
 * whole run and fails on drift. See _helpers/canary.ts for the why.
 */
setup("plant isolation canary", async () => {
  await ensureCanary();
  writeFingerprint(await canaryFingerprint());
});
