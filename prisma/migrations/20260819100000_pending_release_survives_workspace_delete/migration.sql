-- The subscription-release IOU must OUTLIVE the workspace it names.
--
-- Deleting a workspace (or an organization, which cascades through every one of
-- them) never released its Meta webhook subscriptions, so Meta kept POSTing a
-- removed customer's message content at ingest forever — dropped as
-- `unknown_account`, but "we drop it" is not "we don't receive it". The fix
-- releases them, and a failed release owes a `PendingSubscriptionRelease` row.
--
-- That row could not exist while the FK cascaded: the release runs AFTER the
-- workspace is gone (so the "is anyone still using this WABA/Page?" counts see
-- the post-delete world), and a `create` naming a deleted workspace is a FK
-- violation — write it earlier and the cascade takes it instead. SetNull on a
-- nullable column is what lets the IOU survive; the sweeper reads the
-- ciphertexts copied into `secrets` and treats a null workspace as "nothing to
-- re-check or fall back to". (Audit 2026-08-19, U13-03.)
ALTER TABLE "PendingSubscriptionRelease" ALTER COLUMN "workspaceId" DROP NOT NULL;

ALTER TABLE "PendingSubscriptionRelease" DROP CONSTRAINT "PendingSubscriptionRelease_workspaceId_fkey";

ALTER TABLE "PendingSubscriptionRelease" ADD CONSTRAINT "PendingSubscriptionRelease_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;
