-- Team handoff + internal notes on a ticket.
--
-- `team_changed` is deliberately NOT reused from `assigned`: handing a ticket to
-- Sales and someone on Sales claiming it are different events, and a timeline
-- that conflates them cannot answer "how long did this sit in their queue".
--
-- `note` puts the internal discussion on the ticket TIMELINE rather than in a
-- separate table, because that is where it must be read — Sales answering "tell
-- them X" belongs in line with the handoff that asked the question.
--
-- `body` carries the note text and the optional reason on a handoff. A handoff
-- with no reason is the most common way this workflow fails: the receiving team
-- has to re-read the whole thread to work out what was wanted.
ALTER TYPE "TicketEventKind" ADD VALUE IF NOT EXISTS 'team_changed';
ALTER TYPE "TicketEventKind" ADD VALUE IF NOT EXISTS 'note';
ALTER TABLE "TicketEvent" ADD COLUMN "body" TEXT;
