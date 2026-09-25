/**
 * Which of a template's required send-time button values a campaign leaves
 * uncovered — `uncoveredTemplateButtonParams`, the ONE definition broadcast
 * creation and the broadcast runner both gate on.
 *
 * Two copies used to exist and they disagreed: creation accepted a campaign once
 * `variables.buttons` covered every required button, while the runner failed ANY
 * template with a required button, whatever the campaign supplied. Every coupon
 * or dynamic-link campaign was accepted, then failed before the claim with zero
 * sends — and a retry hit the same wall. No test drove such a run, which is how
 * it hid.
 *
 *   pnpm --filter @ccp/api exec vitest run test/template-button-coverage.spec.ts
 */
import { describe, expect, it } from "vitest";

import { uncoveredTemplateButtonParams } from "@ccp/shared/template-render";

const COUPON = [
  { type: "BODY", text: "Your winter discount is here" },
  { type: "BUTTONS", buttons: [{ type: "COPY_CODE", example: "WINTER25" }] },
];

const DYNAMIC_LINK = [
  { type: "BODY", text: "Your order shipped" },
  {
    type: "BUTTONS",
    buttons: [{ type: "URL", text: "Track", url: "https://shop.example/t/{{1}}", example: ["https://shop.example/t/A1"] }],
  },
];

describe("uncoveredTemplateButtonParams", () => {
  it("a coupon campaign that SUPPLIES its code is fully covered — the case that failed every run", () => {
    expect(
      uncoveredTemplateButtonParams(COUPON, "MARKETING", [
        { index: 0, subType: "copy_code", text: "WINTER25" },
      ]),
    ).toEqual([]);
  });

  it("a dynamic-link campaign that supplies its suffix is fully covered", () => {
    expect(
      uncoveredTemplateButtonParams(DYNAMIC_LINK, "UTILITY", [
        { index: 0, subType: "url", text: "A1" },
      ]),
    ).toEqual([]);
  });

  it("reports what is MISSING, so the campaign fails before a single send", () => {
    expect(uncoveredTemplateButtonParams(COUPON, "MARKETING", [])).toEqual([
      expect.objectContaining({ index: 0, subType: "copy_code" }),
    ]);
  });

  it("a blank value does not count as covered", () => {
    expect(
      uncoveredTemplateButtonParams(COUPON, "MARKETING", [
        { index: 0, subType: "copy_code", text: "   " },
      ]),
    ).toHaveLength(1);
  });

  it("a value for the WRONG button index or type does not cover it", () => {
    expect(
      uncoveredTemplateButtonParams(COUPON, "MARKETING", [
        { index: 1, subType: "copy_code", text: "WINTER25" },
        { index: 0, subType: "url", text: "WINTER25" },
      ]),
    ).toHaveLength(1);
  });

  it("a template with only static buttons needs nothing", () => {
    expect(
      uncoveredTemplateButtonParams(
        [{ type: "BUTTONS", buttons: [{ type: "URL", text: "Help", url: "https://a.example/help" }] }],
        "UTILITY",
        [],
      ),
    ).toEqual([]);
  });
});
