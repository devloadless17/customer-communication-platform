-- Ticket SEARCH indexes.
--
-- A workspace past a few hundred tickets could not find one: the board offered
-- status / priority / team / assignee filters and nothing else, so "the refund
-- issue from last week" or "what was #47 about" meant scrolling. Search covers
-- the three places a ticket's words actually live — its subject, its cause, and
-- the comment/note thread on it.
--
-- Trigram GIN, matching how Contact.name / Message.body / InternalNote.body are
-- already searched (ILIKE '%term%' cannot use a btree index at all).
--
-- NOT folded into 0_init's hand-maintained section, per the rule documented
-- there: `Ticket.description` is added by 20260725120000_ticket_description, so
-- listing an index on it in the BASELINE breaks every fresh database with
-- `column "description" does not exist`. Post-baseline indexes live in their own
-- migration, after the column exists, and are asserted by
-- apps/api/test/partial-indexes.spec.ts.
CREATE INDEX "Ticket_subject_trgm_idx" ON public."Ticket" USING gin ("subject" gin_trgm_ops) WHERE ("subject" IS NOT NULL);
CREATE INDEX "Ticket_description_trgm_idx" ON public."Ticket" USING gin ("description" gin_trgm_ops) WHERE ("description" IS NOT NULL);
CREATE INDEX "TicketEvent_body_trgm_idx" ON public."TicketEvent" USING gin ("body" gin_trgm_ops) WHERE ("body" IS NOT NULL);
