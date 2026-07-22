-- Store Meta's `parameter_format` instead of inferring it from the body text.
--
-- Additive with a default, so every existing row keeps the exact behaviour it
-- had: `positional` is what the regex-based inference resolved to for all of
-- them, and it is Meta's own historical default. The next template sync
-- overwrites each row with Meta's authoritative answer.

-- AlterTable
ALTER TABLE "MessageTemplate" ADD COLUMN     "parameterFormat" TEXT NOT NULL DEFAULT 'positional';

