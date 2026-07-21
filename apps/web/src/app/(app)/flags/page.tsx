import { listMessageFlagDefinitions } from "@/lib/api/queries";

import { FlagsQueueClient } from "./flags-queue-client";

/**
 * The triage queue — every unresolved message flag across the team, newest
 * first, with inline resolve / dismiss / reassign.
 *
 * This is the "come back to it later" surface. The inbox's `Flagged` preset
 * answers "which CONVERSATIONS need attention"; this answers "which
 * individual complaints / requests are still open, and who owns each one" —
 * which is the question a supervisor actually asks.
 *
 * Only the catalog is SSR-seeded (it's tiny and drives the rail immediately).
 * The rows themselves are fetched client-side because they are keyset-
 * paginated, filterable, and live-patched by the `message:flag` socket frame —
 * SSR-seeding them would mean the very first interaction discards the seed.
 */
export default async function FlagsPage() {
  const definitions = await listMessageFlagDefinitions();
  return <FlagsQueueClient definitions={definitions} />;
}
