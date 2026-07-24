-- Tickets are DELIBERATE, not automatic.
--
-- `ticketAutoOpen` defaulted to true, so every inbound message opened a ticket
-- on a thread that had none. That made a ticket indistinguishable from a
-- conversation — the inbox already tracks every thread — and produced a board
-- where every "hi" is a work item, which nobody triages.
--
-- A ticket should mean someone decided this needs work: raised by an agent who
-- read the message, with a subject, a priority and an assignee. That flow
-- already exists (POST /api/tickets); it was just drowned out.
--
-- Existing workspaces are switched off too. This is deliberate rather than
-- "new workspaces only": every workspace on this deployment is pre-launch, and
-- leaving the old ones auto-opening would mean the same product behaves
-- differently depending on when the workspace was created. Tickets already
-- opened are untouched — they keep their numbers and their history.
ALTER TABLE "Workspace" ALTER COLUMN "ticketAutoOpen" SET DEFAULT false;
UPDATE "Workspace" SET "ticketAutoOpen" = false WHERE "ticketAutoOpen" = true;
