/**
 * Meta's template field limits.
 *
 * These numbers come from the WhatsApp Business "Template fundamentals" docs.
 * They are pinned here for one reason: they are enforced in TWO places — the
 * create form's character counters and the server's pre-flight rejection — and
 * the whole point of sharing `TEMPLATE_LIMITS` is that those two can never
 * disagree. The form previously carried its own looser numbers (body 1500 vs
 * 1024, header 80 vs 60, footer 70 vs 60), so an author could type past the
 * limit and only learn on submit.
 *
 * A limit STRICTER than Meta's is just as wrong as a looser one: it silently
 * blocks templates Meta would have accepted, which is indistinguishable from a
 * bug. So this asserts exact equality, not bounds.
 *
 *   pnpm --filter @ccp/api exec vitest run test/template-limits.spec.ts
 */
import { describe, expect, it } from "vitest";

import {
  TEMPLATE_LIMITS,
  TEMPLATE_NAME_PATTERN,
  validateTemplateComponents,
} from "@ccp/shared/template-render";

const body = (text: string) => ({ type: "BODY", text });

describe("the documented numbers", () => {
  it("matches Meta's published limits exactly", () => {
    expect(TEMPLATE_LIMITS.bodyMaxLength).toBe(1024);
    expect(TEMPLATE_LIMITS.headerMaxLength).toBe(60);
    expect(TEMPLATE_LIMITS.footerMaxLength).toBe(60);
    expect(TEMPLATE_LIMITS.nameMaxLength).toBe(512);
    expect(TEMPLATE_LIMITS.maxQuickReplyButtons).toBe(10);
    expect(TEMPLATE_LIMITS.maxCallToActionButtons).toBe(2);
  });
});

describe("name", () => {
  it("accepts lowercase, digits and underscores", () => {
    expect(TEMPLATE_NAME_PATTERN.test("order_confirmation_2")).toBe(true);
  });

  it("rejects uppercase, spaces and punctuation", () => {
    for (const bad of ["Order_Confirmation", "order confirmation", "order-confirmation", ""]) {
      expect(TEMPLATE_NAME_PATTERN.test(bad)).toBe(false);
    }
  });
});

describe("validateTemplateComponents", () => {
  it("passes a well-formed template", () => {
    expect(validateTemplateComponents("order_update", [body("Hi {{1}}")])).toEqual([]);
  });

  it("accepts a body EXACTLY at the limit, and rejects one character more", () => {
    // The boundary is the whole point — an off-by-one here either blocks a
    // legal template or lets an illegal one through to Meta.
    expect(
      validateTemplateComponents("t", [body("x".repeat(TEMPLATE_LIMITS.bodyMaxLength))]),
    ).toEqual([]);
    const over = validateTemplateComponents("t", [
      body("x".repeat(TEMPLATE_LIMITS.bodyMaxLength + 1)),
    ]);
    expect(over).toHaveLength(1);
    expect(over[0]!.field).toBe("body");
    // The message names the actual count, so an author can see how far over.
    expect(over[0]!.message).toContain(String(TEMPLATE_LIMITS.bodyMaxLength + 1));
  });

  it("only length-checks a TEXT header — a media header carries no text", () => {
    const long = "x".repeat(TEMPLATE_LIMITS.headerMaxLength + 1);
    expect(
      validateTemplateComponents("t", [body("hi"), { type: "HEADER", format: "TEXT", text: long }]),
    ).toHaveLength(1);
    // An IMAGE header has no text limit to violate.
    expect(
      validateTemplateComponents("t", [body("hi"), { type: "HEADER", format: "IMAGE" }]),
    ).toEqual([]);
  });

  it("caps quick replies at 10 and call-to-action buttons at 2", () => {
    const quick = Array.from({ length: 11 }, () => ({ type: "QUICK_REPLY", text: "ok" }));
    expect(
      validateTemplateComponents("t", [body("hi"), { type: "BUTTONS", buttons: quick }]),
    ).not.toHaveLength(0);

    const ctas = Array.from({ length: 3 }, () => ({ type: "URL", text: "open" }));
    const issues = validateTemplateComponents("t", [
      body("hi"),
      { type: "BUTTONS", buttons: ctas },
    ]);
    expect(issues.some((i) => i.field === "buttons")).toBe(true);
  });

  it("reports EVERY problem at once, not just the first", () => {
    // One form pass instead of whack-a-mole with a 400 per field.
    const issues = validateTemplateComponents("Bad Name", [
      body("x".repeat(TEMPLATE_LIMITS.bodyMaxLength + 1)),
      { type: "FOOTER", text: "y".repeat(TEMPLATE_LIMITS.footerMaxLength + 1) },
    ]);
    expect(issues.map((i) => i.field).sort()).toEqual(["body", "footer", "name"]);
  });
});
