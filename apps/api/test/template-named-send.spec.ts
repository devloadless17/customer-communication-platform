import { describe, expect, it } from "vitest";

import { SendTemplateSchema } from "@/messages/messages.schemas";
import {
  renderTemplateBodyNamed,
  templateNamedPlaceholders,
} from "@ccp/shared/template-render";

/**
 * NAMED-format templates, end to end through the boundary that was broken.
 *
 * A template created in WhatsApp Manager with `{{order_id}}` placeholders synced
 * in fine and the send path already understood `variables.bodyNamed` — but the
 * internal send SCHEMA had no such field and the inbox picker counted only
 * `{{1}}`-style placeholders. Net effect: the picker said "this template has no
 * variables", the agent sent, and the server rejected with
 * `named_body_vars_required` with no way forward. These lock the fix.
 */

describe("SendTemplateSchema — named body variables", () => {
  it("accepts bodyNamed", () => {
    const parsed = SendTemplateSchema.parse({
      conversationId: "c1",
      templateId: "t1",
      variables: {
        body: [],
        bodyNamed: [
          { name: "first_name", text: "Jessica" },
          { name: "order_number", text: "SKBUP2-4CPIG9" },
        ],
      },
    });
    expect(parsed.variables.bodyNamed).toHaveLength(2);
  });

  it("still accepts a positional-only send unchanged", () => {
    const parsed = SendTemplateSchema.parse({
      conversationId: "c1",
      templateId: "t1",
      variables: { body: ["Jessica", "860198"] },
    });
    expect(parsed.variables.bodyNamed).toBeUndefined();
    expect(parsed.variables.body).toEqual(["Jessica", "860198"]);
  });

  it("rejects a nameless entry — the provider needs `parameter_name`", () => {
    expect(() =>
      SendTemplateSchema.parse({
        conversationId: "c1",
        templateId: "t1",
        variables: { body: [], bodyNamed: [{ name: "", text: "x" }] },
      }),
    ).toThrow();
  });
});

describe("named placeholder extraction drives the picker", () => {
  const body = "Thank you, {{first_name}}! Your order number is {{order_number}}.";

  it("enumerates names in first-appearance order", () => {
    expect(templateNamedPlaceholders(body)).toEqual(["first_name", "order_number"]);
  });

  it("does not fire on a positional body", () => {
    expect(templateNamedPlaceholders("Hi {{1}}, order {{2}} shipped")).toEqual([]);
  });

  it("renders the preview the agent sees", () => {
    const names = templateNamedPlaceholders(body);
    const values = ["Jessica", "SKBUP2"];
    expect(
      renderTemplateBodyNamed(
        body,
        names.map((name, i) => ({ name, text: values[i] ?? "" })),
      ),
    ).toBe("Thank you, Jessica! Your order number is SKBUP2.");
  });

  it("leaves an unfilled name visible rather than blanking it", () => {
    // Matches the positional renderer's behaviour, and matters because the
    // picker's send button is gated on every field being non-empty — a silently
    // blanked placeholder would look filled.
    expect(renderTemplateBodyNamed(body, [{ name: "first_name", text: "Jessica" }])).toBe(
      "Thank you, Jessica! Your order number is {{order_number}}.",
    );
  });
});
