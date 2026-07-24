-- Template Library provenance.
--
-- libraryTemplateName: Meta's own marker (`library_template_name`) that a
-- template was instantiated from a Template Library blueprint. Two consequences
-- follow from it, which is why it is stored rather than inferred: the copy is
-- FIXED and uneditable, and the body parameters are TYPE-CHECKED by Meta at send
-- time.
--
-- bodyParamTypes: the declared value type per body parameter
-- (`{TEXT,AMOUNT,DATE}`), positionally aligned with the body's `{{n}}`. These are
-- readable ONLY from the library catalogue -- the template node never returns
-- them -- so they are captured at instantiation and cannot be recovered by a
-- later sync. Without them, a value Meta rejects fails the send with no
-- indication of WHICH parameter was wrong.
--
-- Both additive; existing rows are unaffected (null / empty array).
ALTER TABLE "MessageTemplate" ADD COLUMN "libraryTemplateName" TEXT;
ALTER TABLE "MessageTemplate" ADD COLUMN "bodyParamTypes" TEXT[] DEFAULT ARRAY[]::TEXT[];
