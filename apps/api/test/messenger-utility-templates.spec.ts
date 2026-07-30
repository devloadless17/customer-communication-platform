/**
 * Utility messages — Messenger's approved-template send, and the only outbound
 * that legitimately bypasses the 24-hour window now that Meta killed the three
 * update tags on 2026-04-27.
 *
 * Every assertion here is a way to be silently wrong: a case mismatch that
 * surfaces as a parameter-count error, a `parameter_name` on the wrong format,
 * and a URL button suffix that double-prefixes.
 *
 *   pnpm --filter @ccp/api exec vitest run test/messenger-utility-templates.spec.ts
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createUtilityTemplate,
  listUtilityTemplates,
  sendUtilityMessage,
} from "@/lib/providers/messenger-utility-templates";

const target = {
  accountId: "PAGE_1",
  accessToken: "page-tok",
  graphVersion: "v26.0",
  label: "messenger",
};

interface Call {
  url: string;
  body: Record<string, unknown> | undefined;
}

function mockGraph(responses: unknown[]): Call[] {
  const calls: Call[] = [];
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(
        JSON.stringify(responses[Math.min(i++, responses.length - 1)] ?? {}),
        { status: 200 },
      );
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("sendUtilityMessage", () => {
  it("uses messaging_type UTILITY and LOWERCASE component types", async () => {
    const calls = mockGraph([{ recipient_id: "PSID_1", message_id: "m_1" }]);

    await sendUtilityMessage(
      {
        to: "PSID_1",
        templateName: "order_confirmation_us",
        languageCode: "en",
        bodyParameters: [{ text: "confirmed" }],
        buttonParameters: [{ type: "URL", urlSuffix: "1234" }],
      },
      target,
    );

    const body = calls[0]!.body!;
    // A fourth enum value beside RESPONSE / UPDATE / MESSAGE_TAG. Sending a
    // template under MESSAGE_TAG does not work.
    expect(body.messaging_type).toBe("UTILITY");
    const template = (body.message as { template: Record<string, unknown> }).template;
    expect(template.name).toBe("order_confirmation_us");
    expect(template.language).toEqual({ code: "en" });
    // LOWERCASE at send time; UPPERCASE at create time. Meta's own examples show
    // both one line apart, and the mismatch fails as a parameter-count error that
    // reads like the caller passed the wrong number of variables.
    expect(template.components).toEqual([
      { type: "body", parameters: [{ type: "text", text: "confirmed" }] },
      // The URL parameter carries the SUFFIX, not a whole URL — a full URL gets
      // double-prefixed onto the template's own.
      { type: "buttons", parameters: [{ type: "URL", url: "1234" }] },
    ]);
  });

  it("omits parameter_name on a POSITIONAL template", async () => {
    const calls = mockGraph([{ message_id: "m_1" }]);
    await sendUtilityMessage(
      {
        to: "PSID_1",
        templateName: "t",
        languageCode: "en",
        bodyParameters: [{ text: "confirmed", name: "order_status" }],
      },
      target,
    );
    const template = (calls[0]!.body!.message as { template: { components: unknown[] } }).template;
    // The caller passed a name; the template is positional, so it must not ship.
    expect(template.components[0]).toEqual({
      type: "body",
      parameters: [{ type: "text", text: "confirmed" }],
    });
  });

  it("emits parameter_name on a NAMED template", async () => {
    const calls = mockGraph([{ message_id: "m_1" }]);
    await sendUtilityMessage(
      {
        to: "PSID_1",
        templateName: "t",
        languageCode: "en",
        parameterFormat: "NAMED",
        bodyParameters: [{ text: "confirmed", name: "order_status" }],
        buttonParameters: [{ type: "URL", urlSuffix: "1234" }],
      },
      target,
    );
    const template = (calls[0]!.body!.message as { template: { components: unknown[] } }).template;
    expect(template.components[0]).toEqual({
      type: "body",
      parameters: [{ type: "text", text: "confirmed", parameter_name: "order_status" }],
    });
    // "URL button suffixes continue to use positional parameters" — the button
    // parameter never gains a name, even on a NAMED template.
    expect(template.components[1]).toEqual({
      type: "buttons",
      parameters: [{ type: "URL", url: "1234" }],
    });
  });

  it("sends no components at all when the template has no variables", async () => {
    const calls = mockGraph([{ message_id: "m_1" }]);
    await sendUtilityMessage({ to: "PSID_1", templateName: "t", languageCode: "en" }, target);
    const template = (calls[0]!.body!.message as { template: Record<string, unknown> }).template;
    // An empty `components: []` is not the same as absent for Meta.
    expect(template).not.toHaveProperty("components");
  });
});

describe("createUtilityTemplate", () => {
  it("forces category UTILITY and only sends parameter_format when NAMED", async () => {
    // Both responses need an `id`: a create that returns none is a real error
    // (there would be nothing to send with), and the function is right to throw.
    const calls = mockGraph([
      { id: "1", status: "APPROVED", category: "UTILITY" },
      { id: "2", status: "APPROVED", category: "UTILITY" },
    ]);

    await createUtilityTemplate(
      { name: "t", language: "en", components: [{ type: "BODY", text: "Your order is {{1}}" }] },
      target,
    );
    expect(calls[0]!.body).toMatchObject({ category: "UTILITY" });
    // Sending POSITIONAL explicitly is not documented.
    expect(calls[0]!.body).not.toHaveProperty("parameter_format");

    await createUtilityTemplate(
      { name: "t2", language: "en", parameterFormat: "NAMED", components: [] },
      target,
    );
    expect(calls[1]!.body).toMatchObject({ parameter_format: "NAMED" });
  });
});

describe("listUtilityTemplates", () => {
  it("reads parameter_format from Meta and defaults to POSITIONAL", async () => {
    mockGraph([
      {
        data: [
          { id: "1", name: "a", parameter_format: "NAMED", status: "APPROVED" },
          // No parameter_format — must NOT be inferred from body text. A template
          // whose copy legitimately contains {{word}} would otherwise be misread
          // as NAMED and fail every recipient.
          { id: "2", name: "b", components: [{ type: "BODY", text: "Hi {{name}}" }] },
        ],
      },
    ]);
    const templates = await listUtilityTemplates(target);
    expect(templates.map((t) => t.parameterFormat)).toEqual(["NAMED", "POSITIONAL"]);
  });
});
