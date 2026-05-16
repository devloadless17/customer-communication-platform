-- Automation depth pass: add the conversation_created trigger and the four
-- internal action types (send_template / assign_to_user / set_status / add_tag).
-- Existing webhook rules are untouched — both enums are additive.

ALTER TYPE "AutomationTriggerEvent" ADD VALUE IF NOT EXISTS 'conversation_created';

ALTER TYPE "AutomationActionType" ADD VALUE IF NOT EXISTS 'send_template';
ALTER TYPE "AutomationActionType" ADD VALUE IF NOT EXISTS 'assign_to_user';
ALTER TYPE "AutomationActionType" ADD VALUE IF NOT EXISTS 'set_status';
ALTER TYPE "AutomationActionType" ADD VALUE IF NOT EXISTS 'add_tag';
