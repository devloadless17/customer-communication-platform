/**
 * The MESSENGER-ONLY half of the Messenger Profile API
 * (`/{page-id}/messenger_profile`): the Get Started button, the per-locale
 * greeting, and the commands menu.
 *
 * Kept out of `meta-social.ts` on purpose. That module is the SHARED Messenger +
 * Instagram surface, and it already owns the two profile fields both channels
 * really have (`ice_breakers`, `persistent_menu` — see `getChannelEntryPoints`).
 * The three fields here exist on Messenger and nowhere else: Instagram's profile
 * node accepts neither `get_started` nor `greeting` nor `commands`, so putting
 * them behind the shared, platform-parameterised helpers would create a code path
 * that is only ever correct for one of its two callers. No `platform=` query
 * param appears below for the same reason.
 *
 * ## Why the Get Started button is load-bearing, not decoration
 *
 * Meta: get_started is "the payload that will be sent as a `messaging_postbacks`
 * event when someone taps the 'get started' button on your Page Messenger welcome
 * screen." Until it is set, a person who has never messaged the Page sees an empty
 * composer with no call to action, and the welcome screen has nothing to render —
 * which is also why the greeting only appears once this exists. The parser has
 * handled the resulting postback since social shipped (it surfaces as an
 * `interactiveReply`, so `ask_question` and workflow triggers route on it); the
 * button that produces it was simply never configurable.
 *
 * ## Rate limit
 *
 * "Calls to the Messenger Profile API are limited to 10 API calls per 10 minute
 * interval… enforced per Page." That is small enough that a settings page which
 * reads on every render would exhaust it, so callers read once per page load and
 * write only on save — and a read here fetches all three fields in ONE request
 * rather than one request per field.
 */

import {
  GRAPH_BASE,
  graphDeleteJson,
  graphGetJson,
  graphPostJson,
} from "@/lib/providers/meta-graph";
import type { SocialSendTarget } from "@/lib/providers/meta-social";

/**
 * Meta's cap on the commands menu. The Commands reference documents "a maximum
 * of 10 commands" per locale, each with a name of up to 32 characters and a
 * description of up to 64. Exported so the request schema reads the same numbers
 * the wire enforces instead of a second copy that can drift.
 */
export const MAX_COMMANDS = 10;
export const MAX_COMMAND_NAME_CHARS = 32;
export const MAX_COMMAND_DESCRIPTION_CHARS = 64;
/** Greeting text cap, per the Greeting reference. */
export const MAX_GREETING_CHARS = 160;

/**
 * A tappable command in the Messenger commands menu. `name` is what the customer
 * types after `/`; Meta echoes it back as an ordinary `messaging_postbacks` event,
 * so nothing downstream needs to know commands exist.
 */
export interface MessengerCommand {
  name: string;
  description: string;
}

/**
 * The Messenger welcome surface, as the domain sees it.
 *
 * `getStartedPayload` is `null` when the button is not configured — which is a
 * genuinely different state from "configured with an empty payload", because the
 * button either exists in the customer's thread or it does not.
 *
 * `greeting` is the `default` locale only. Meta stores an array keyed by locale
 * and REQUIRES a `default` entry; a set with no default silently renders nothing.
 * Rather than expose a locale table nobody is asking for yet, we read and write
 * the default and leave any other locale a previous tool configured untouched —
 * see the merge in {@link setMessengerWelcome}.
 */
export interface MessengerWelcome {
  getStartedPayload: string | null;
  greeting: string | null;
  commands: MessengerCommand[];
}

/** The default payload we set when an operator enables the button without one. */
export const DEFAULT_GET_STARTED_PAYLOAD = "CCP_GET_STARTED";

function profileUrl(opts: SocialSendTarget, query = ""): string {
  const base = `${GRAPH_BASE}/${opts.graphVersion}/${opts.accountId}/messenger_profile`;
  return query ? `${base}?${query}` : base;
}

/** Pull the `default`-locale entry out of one of Meta's per-locale arrays. */
function defaultLocaleEntry(value: unknown): Record<string, unknown> | null {
  if (!Array.isArray(value)) return null;
  for (const entry of value as Array<Record<string, unknown>>) {
    // Meta omits `locale` on some historical rows; treat an absent locale as the
    // default rather than skipping it, or a profile set by an older tool reads
    // back as unconfigured and the next save silently wipes it.
    if (entry.locale === undefined || entry.locale === "default") return entry;
  }
  return null;
}

/**
 * Read the Page's Get Started button, greeting and commands in one call.
 *
 * Meta returns `{ data: [ { … } ] }` with ONLY the fields that are actually set —
 * an unconfigured Page answers `{ data: [] }` rather than 404ing — so every field
 * degrades to its "not configured" value instead of throwing.
 */
export async function getMessengerWelcome(
  opts: SocialSendTarget,
): Promise<MessengerWelcome> {
  const res = await graphGetJson(
    profileUrl(opts, "fields=get_started,greeting,commands"),
    opts.accessToken,
    { retry: true },
    opts.appSecret,
  );
  const data = Array.isArray(res.data) ? (res.data as Array<Record<string, unknown>>) : [];

  let getStartedPayload: string | null = null;
  let greeting: string | null = null;
  const commands: MessengerCommand[] = [];

  for (const entry of data) {
    const gs = entry.get_started as { payload?: unknown } | undefined;
    if (gs && typeof gs.payload === "string") getStartedPayload = gs.payload;

    const g = defaultLocaleEntry(entry.greeting);
    if (g && typeof g.text === "string") greeting = g.text;

    // `commands` nests one level deeper than the others: an array of locale
    // objects, each carrying its own `commands` array.
    const c = defaultLocaleEntry(entry.commands);
    const list = c && Array.isArray(c.commands) ? (c.commands as Array<Record<string, unknown>>) : [];
    for (const cmd of list) {
      if (typeof cmd.name === "string" && typeof cmd.description === "string") {
        commands.push({ name: cmd.name, description: cmd.description });
      }
    }
  }

  return { getStartedPayload, greeting, commands };
}

/**
 * Write the Page's welcome surface.
 *
 * Each field is SET or CLEARED independently, and clearing goes through Meta's
 * own `DELETE … {fields:[…]}` shape rather than posting an empty value. That
 * distinction is not pedantic: `POST` is documented to overwrite only the
 * properties present in the body, and there is no documented "empty clears it"
 * behaviour — posting `greeting: []` would leave the previous greeting live while
 * our settings page showed none. Same reasoning as `setChannelEntryPoints`.
 *
 * The greeting is written for the `default` locale only. Meta requires that
 * locale to exist, and every other locale on the node is left exactly as it was:
 * a business that configured `en_US` and `fr_FR` in Business Suite keeps both.
 */
export async function setMessengerWelcome(
  welcome: MessengerWelcome,
  opts: SocialSendTarget,
): Promise<void> {
  const profile: Record<string, unknown> = {};
  const clear: string[] = [];

  if (welcome.getStartedPayload) {
    profile.get_started = { payload: welcome.getStartedPayload };
  } else {
    clear.push("get_started");
  }

  const greetingText = welcome.greeting?.trim();
  if (greetingText) {
    profile.greeting = [{ locale: "default", text: greetingText }];
  } else {
    clear.push("greeting");
  }

  if (welcome.commands.length > 0) {
    profile.commands = [{ locale: "default", commands: welcome.commands }];
  } else {
    clear.push("commands");
  }

  if (Object.keys(profile).length > 0) {
    await graphPostJson(profileUrl(opts), opts.accessToken, profile, opts.appSecret);
  }
  if (clear.length > 0) {
    await graphDeleteJson(profileUrl(opts), opts.accessToken, { fields: clear }, opts.appSecret);
  }
}
