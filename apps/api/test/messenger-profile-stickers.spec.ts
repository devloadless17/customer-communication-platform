/**
 * Messenger Profile API (Get Started / greeting / commands) and the Sticker API.
 *
 * These pin the WIRE SHAPE, because both surfaces have a failure mode where Meta
 * accepts the request and does nothing: a clear posted as an empty value instead
 * of the documented `DELETE {fields:[…]}`, and a catalog read sent with the wrong
 * kind of token.
 *
 *   pnpm --filter @ccp/api exec vitest run test/messenger-profile-stickers.spec.ts
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getMessengerWelcome,
  setMessengerWelcome,
} from "@/lib/providers/messenger-profile";
import {
  LIKE_STICKER_ID,
  listStickerPacks,
  searchStickers,
  sendMessengerSticker,
} from "@/lib/providers/messenger-stickers";

const target = {
  accountId: "PAGE_1",
  accessToken: "page-tok",
  graphVersion: "v26.0",
  label: "messenger",
};

interface Call {
  url: string;
  method: string;
  body: unknown;
  auth: string | undefined;
}

/** Record every Graph call and reply with `responses` in order. */
function mockGraph(responses: unknown[]): Call[] {
  const calls: Call[] = [];
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        auth: headers.authorization,
      });
      const body = responses[Math.min(i++, responses.length - 1)] ?? {};
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("Messenger Profile API — welcome screen", () => {
  it("reads all three fields in ONE request", async () => {
    const calls = mockGraph([
      {
        data: [
          { get_started: { payload: "CCP_GET_STARTED" } },
          { greeting: [{ locale: "default", text: "Hi!" }, { locale: "fr_FR", text: "Salut" }] },
          {
            commands: [
              { locale: "default", commands: [{ name: "help", description: "Get help" }] },
            ],
          },
        ],
      },
    ]);

    const welcome = await getMessengerWelcome(target);

    // The profile node allows only 10 calls per 10 minutes PER PAGE, so a
    // field-per-request read would exhaust it from one settings page.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("fields=get_started,greeting,commands");
    // Messenger-only node — no `platform=` param (that is Instagram's).
    expect(calls[0]!.url).not.toContain("platform=");
    expect(welcome).toEqual({
      getStartedPayload: "CCP_GET_STARTED",
      // The `default` locale only; the fr_FR entry is left alone, not merged.
      greeting: "Hi!",
      commands: [{ name: "help", description: "Get help" }],
    });
  });

  it("treats an unconfigured Page as unset rather than an error", async () => {
    mockGraph([{ data: [] }]);
    expect(await getMessengerWelcome(target)).toEqual({
      getStartedPayload: null,
      greeting: null,
      commands: [],
    });
  });

  it("CLEARS an emptied field with DELETE {fields}, not an empty POST", async () => {
    const calls = mockGraph([{ result: "success" }, { result: "success" }]);

    await setMessengerWelcome(
      { getStartedPayload: "CCP_GET_STARTED", greeting: null, commands: [] },
      target,
    );

    const post = calls.find((c) => c.method === "POST");
    const del = calls.find((c) => c.method === "DELETE");
    // Only the field that has a value is POSTed…
    expect(post?.body).toEqual({ get_started: { payload: "CCP_GET_STARTED" } });
    // …and the two emptied ones are deleted. POSTing `greeting: []` is not
    // documented to clear anything: it would leave the old greeting live while
    // the settings page showed none.
    expect(del?.body).toEqual({ fields: ["greeting", "commands"] });
  });

  it("wraps the greeting in the default locale Meta requires", async () => {
    const calls = mockGraph([{ result: "success" }]);
    await setMessengerWelcome(
      { getStartedPayload: "P", greeting: "Welcome", commands: [] },
      target,
    );
    const post = calls.find((c) => c.method === "POST")!;
    // A greeting with no `default` locale silently renders nothing.
    expect((post.body as { greeting: unknown }).greeting).toEqual([
      { locale: "default", text: "Welcome" },
    ]);
  });
});

describe("Sticker API", () => {
  const auth = { appId: "APP_1", appSecret: "APP_SECRET", graphVersion: "v26.0" };

  it("authenticates the catalog with an APP token, not the Page token", async () => {
    const calls = mockGraph([{ data: [{ id: "1", name: "Catster", sticker_count: 21 }] }]);
    const packs = await listStickerPacks(auth);
    // Meta: the catalog endpoints "use an App Access Token (concatenated
    // app_id|app_secret)". A Page token is rejected here.
    expect(calls[0]!.auth).toBe("Bearer APP_1|APP_SECRET");
    expect(packs[0]).toMatchObject({ id: "1", name: "Catster", stickerCount: 21 });
  });

  it("forwards locale on search", async () => {
    const calls = mockGraph([{ data: [] }]);
    await searchStickers("감사", auth, "ko_KR");
    // Without locale the API defaults to en_US and matches only English tags, so
    // a non-English query returns an empty list instead of an error.
    expect(calls[0]!.url).toContain("locale=ko_KR");
  });

  it("skips the round trip below Meta's 2-character minimum", async () => {
    const calls = mockGraph([{ data: [] }]);
    expect(await searchStickers("a", auth)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("sends a sticker as message.sticker_id with the caller's messaging_type", async () => {
    const calls = mockGraph([{ recipient_id: "PSID_1", message_id: "m_1" }]);

    const res = await sendMessengerSticker(
      { to: "PSID_1", stickerId: LIKE_STICKER_ID },
      target,
      { messaging_type: "RESPONSE" },
    );

    // A sticker is its OWN message shape — not an attachment envelope, and it
    // carries no text.
    expect(calls[0]!.body).toEqual({
      recipient: { id: "PSID_1" },
      messaging_type: "RESPONSE",
      message: { sticker_id: LIKE_STICKER_ID },
    });
    // The send uses the PAGE token, unlike the catalog reads above.
    expect(calls[0]!.auth).toBe("Bearer page-tok");
    expect(res.externalId).toBe("m_1");
  });
});
