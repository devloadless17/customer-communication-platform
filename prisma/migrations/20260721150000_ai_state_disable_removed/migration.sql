-- Agents can no longer explicitly "disable" the AI assistant on a
-- conversation (only pause/resume/take-over remain) — the `disabled` state
-- is now unreachable from application code. Move any pre-existing disabled
-- rows to ai_paused so no live conversation is stuck in a state the UI can no
-- longer surface an action for. The `disabled` enum label itself is left in
-- place (dropping a Postgres enum value requires a full type-swap for zero
-- benefit here) — it is simply dead going forward.
UPDATE "AiConversationState" SET "state" = 'ai_paused', "stateChangedAt" = CURRENT_TIMESTAMP WHERE "state" = 'disabled';
