-- Revert the conversation-tags refactor. After honest discussion with the
-- product owner, the prior split — tags on Contact, not Conversation — is
-- the right shape for THIS app's workflow (one contact = one conversation,
-- enforced now in the ingest / broadcast / forward paths). Moving tags onto
-- Conversation was speculative Front/Intercom-style flexibility this app
-- doesn't need; reverting removes the dead JOIN hop from every tag query.
--
-- Idempotent data shuffle: recreate `_ContactToTag` first, copy the union
-- of (contactId, tagId) pairs from `_ConversationTags` (joined through
-- Conversation), THEN drop `_ConversationTags`. Order matters — we'd lose
-- the data if we dropped the source table first.
--
-- The `tag_added` / `tag_removed` values stay in the `ConversationEventKind`
-- enum (Postgres can't easily DROP enum values without recreating the type).
-- Harmless: no write site references them anymore after the code revert.

CREATE TABLE "_ContactToTag" (
  "A" TEXT NOT NULL,
  "B" TEXT NOT NULL,
  CONSTRAINT "_ContactToTag_AB_pkey" PRIMARY KEY ("A","B")
);
CREATE INDEX "_ContactToTag_B_index" ON "_ContactToTag"("B");

ALTER TABLE "_ContactToTag"
  ADD CONSTRAINT "_ContactToTag_A_fkey"
  FOREIGN KEY ("A") REFERENCES "Contact"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "_ContactToTag"
  ADD CONSTRAINT "_ContactToTag_B_fkey"
  FOREIGN KEY ("B") REFERENCES "Tag"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Copy: every (contact, tag) pair derivable from the conversation-level
-- join. DISTINCT collapses the duplicates introduced by the original
-- forward migration (which fanned a single contact-tag onto every one of
-- that contact's conversations).
INSERT INTO "_ContactToTag" ("A", "B")
SELECT DISTINCT co."contactId", ct."B"
FROM "_ConversationTags" ct
JOIN "Conversation" co ON co.id = ct."A"
ON CONFLICT DO NOTHING;

DROP TABLE "_ConversationTags";
