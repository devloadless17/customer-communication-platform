-- contactId-leading indexes to back the Contact-cascade delete (GDPR hard-purge).
-- The existing composites on these tables are teamId-leading
-- (WorkflowAwaitingReply: (teamId, contactId); CallPermissionRequest:
-- (teamId, contactId, requestedAt)) and cannot serve a bare `contactId =`
-- predicate, so deleting a Contact's children seq-scans without these. Both
-- tables are small, so creation is cheap and non-blocking in practice.

-- CreateIndex
CREATE INDEX "WorkflowAwaitingReply_contactId_idx" ON "WorkflowAwaitingReply"("contactId");

-- CreateIndex
CREATE INDEX "CallPermissionRequest_contactId_idx" ON "CallPermissionRequest"("contactId");
