-- WhatsApp Coexistence: mark outbound messages sent from the owner's phone app.
--
-- `api` (default) = sent through this platform (agent / automation / broadcast /
-- /v1 API). Every existing row was an API/agent/inbound row, so the NOT NULL
-- DEFAULT backfills them correctly with no data migration. `business_app` is set
-- only by the Coexistence echo/history ingest path for messages mirrored back
-- from the WhatsApp Business App.

-- CreateEnum
CREATE TYPE "MessageOrigin" AS ENUM ('api', 'business_app');

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "origin" "MessageOrigin" NOT NULL DEFAULT 'api';
