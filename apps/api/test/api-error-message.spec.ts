import { describe, expect, it } from "vitest";

import {
  apiErrorMessage,
  humanizeErrorKey,
  NETWORK_ERROR_MESSAGE,
} from "@ccp/shared/api/error-message";

/**
 * What the user actually reads when a request fails.
 *
 * The API's error contract is `{ error: "<snake_case_key>", detail?: "<sentence>" }`.
 * Roughly 50 endpoints write a real sentence into `detail`, and ~24 web call
 * sites were rendering `.error` alone — so an admin who hit a seat cap saw
 *
 *     member_limit_reached
 *
 * instead of "This workspace is at its member limit (2 members). Ask your
 * platform administrator to raise the limit before inviting more." The server
 * had already done the work; the UI discarded it.
 *
 * These are pure functions over a `Response`, so they are tested directly.
 */

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("apiErrorMessage", () => {
  it("prefers `detail` — the sentence written for a human", async () => {
    const res = json(409, {
      error: "member_limit_reached",
      detail: "This workspace is at its member limit (2 members).",
    });
    expect(await apiErrorMessage(res, "fallback")).toBe(
      "This workspace is at its member limit (2 members).",
    );
  });

  it("humanizes the key when there is no detail", async () => {
    // The important middle rung: most endpoints send no detail, so this
    // improves every one of them for free without touching the API.
    const res = json(409, { error: "already_in_organization" });
    expect(await apiErrorMessage(res, "fallback")).toBe("Already in organization");
  });

  it("falls back when the body carries neither", async () => {
    expect(await apiErrorMessage(json(500, {}), "Failed to save")).toBe("Failed to save");
  });

  it("survives a non-JSON body instead of throwing", async () => {
    // A proxy's HTML error page, or an empty 502. Parsing must not replace a
    // useful message with a parse exception — that turns a server blip into a
    // broken screen.
    const res = new Response("<html>502 Bad Gateway</html>", { status: 502 });
    expect(await apiErrorMessage(res, "Failed to save")).toBe("Failed to save");
  });

  it("ignores blank and non-string values", async () => {
    expect(await apiErrorMessage(json(400, { detail: "   ", error: "bad_input" }), "f")).toBe(
      "Bad input",
    );
    expect(await apiErrorMessage(json(400, { error: 42, detail: null }), "f")).toBe("f");
  });
});

describe("humanizeErrorKey", () => {
  it("sentence-cases and de-snakes", () => {
    expect(humanizeErrorKey("workspace_not_found")).toBe("Workspace not found");
    expect(humanizeErrorKey("invite-expired")).toBe("Invite expired");
  });

  it("does not upper-case the rest of the string", () => {
    // Deliberate: title-casing would mangle keys carrying acronyms and produce
    // "Api Key Invalid". Sentence case is the safe transform.
    expect(humanizeErrorKey("api_key_invalid")).toBe("Api key invalid");
  });

  it("returns empty for an empty key so the caller's fallback wins", () => {
    expect(humanizeErrorKey("")).toBe("");
    expect(humanizeErrorKey("___")).toBe("");
  });
});

describe("NETWORK_ERROR_MESSAGE", () => {
  it("exists, because apiFetch THROWS rather than returning a response", () => {
    // On a 401 or any network failure `apiFetch` throws. Every mutation needs a
    // catch; an unguarded one leaves a spinner running forever with nothing on
    // screen — the exact bug the platform delete button shipped with.
    expect(NETWORK_ERROR_MESSAGE).toMatch(/couldn't reach the server/i);
  });
});
