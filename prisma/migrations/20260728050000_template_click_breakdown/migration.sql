-- Meta's template_analytics `clicked` is an ARRAY of per-button entries
-- ({ type, button_content, count }), not a scalar. The scalar `clicked`
-- column keeps the headline "link clicks" figure; this column preserves the
-- full breakdown — which button, quick-reply vs URL, unique vs total —
-- which is otherwise unrecoverable once Meta's 7-day click window closes.
ALTER TABLE "TemplateAnalyticsDaily" ADD COLUMN "clickedButtons" JSONB;
