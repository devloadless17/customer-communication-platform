import type { LibraryTemplate, ProviderTemplate, ProviderTemplateAnalyticsRow, ProviderTemplateComparison, TemplateButtonClicks, TemplateCategory, TemplateComponent, TemplateParamType, TemplateStatus, TemplateVariableSet } from "@ccp/shared/providers/types";

/** Narrow unknown to a plain object — the wire-shape guard meta.ts shares. */
export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * WhatsApp TEMPLATE parsing + send-component construction — extracted from
 * meta.ts (stage 1 of its split, 2026-07-31). Everything here is a PURE
 * function over wire shapes: building the components array a template send
 * posts, normalizing Meta's template rows (sync), and parsing the
 * template-analytics / compare / tier payloads. The provider imports these;
 * meta.ts also re-exports every public name so existing
 * `@/lib/providers/meta` imports keep working (its established facade role).
 */

/**
 * Assemble the `components` array a template send needs.
 *
 * Extracted from `sendTemplate` so the wire shape is unit-testable: this is
 * where a mistake costs EVERY recipient of a broadcast (Meta answers a malformed
 * parameter set with 132000 per message), and it is pure — inputs in, payload
 * out, no network.
 */
export function buildTemplateSendComponents(
  variables: TemplateVariableSet,
): Array<Record<string, unknown>> {
  // Build the `components` array Meta expects. Each parameterized component
  // becomes one entry with `type` ("header" | "body" | "button") and a
  // `parameters` array of `{ type: "text", text }`. Empty arrays are omitted
  // entirely — sending an empty `parameters` triggers Meta error 132000.
  const components: Array<Record<string, unknown>> = [];
  // Media header (IMAGE/VIDEO/DOCUMENT) takes precedence — Meta wants the
  // parameter typed to the media kind with a `{ link }` (or `{ id }`) object,
  // NOT a text parameter. A template's header is either text OR media, never
  // both, so these two branches are mutually exclusive.
  if (variables.headerMedia) {
    const { kind, link, id, filename } = variables.headerMedia;
    // `id` wins over `link` when both are present. Meta accepts either but
    // recommends the id: a link makes Meta fetch from our server on every
    // send, which is slower and one more failure mode. Sending both is not a
    // documented shape, so we pick rather than pass both through.
    const media: Record<string, unknown> = id ? { id } : { link };
    if (kind === "document" && filename) media.filename = filename;
    components.push({
      type: "header",
      parameters: [{ type: kind, [kind]: media }],
    });
  } else if (variables.headerLocation) {
    // LOCATION headers are declared with NO parameters at create time and
    // carry the entire pin here. Coordinates are required; `name` and `address`
    // are optional labels on the map card.
    const { latitude, longitude, name, address } = variables.headerLocation;
    components.push({
      type: "header",
      parameters: [
        {
          type: "location",
          // Omit the optional labels rather than sending empty strings, which
          // Meta renders as a blank caption on the card.
          location: {
            latitude,
            longitude,
            ...(name ? { name } : {}),
            ...(address ? { address } : {}),
          },
        },
      ],
    });
  } else if (variables.headerNamed) {
    // NAMED-format template: Meta requires `parameter_name` on the header
    // component exactly like the body, else it rejects with 132000.
    components.push({
      type: "header",
      parameters: [
        {
          type: "text",
          parameter_name: variables.headerNamed.name,
          text: variables.headerNamed.text,
        },
      ],
    });
  } else if (variables.header && variables.header.length > 0) {
    components.push({
      type: "header",
      parameters: [{ type: "text", text: variables.header }],
    });
  }
  // Body params. Named format (`parameter_format: NAMED`, `{{order_id}}`)
  // takes precedence when the caller supplied `bodyNamed`; otherwise the
  // positional `{{1}}, {{2}}, …` array. Empty in both cases → no body entry.
  if (variables.bodyNamed && variables.bodyNamed.length > 0) {
    components.push({
      type: "body",
      parameters: variables.bodyNamed.map(({ name, text }) => ({
        type: "text",
        parameter_name: name,
        text,
      })),
    });
  } else if (variables.body.length > 0) {
    components.push({
      type: "body",
      parameters: variables.body.map((text) => ({ type: "text", text })),
    });
  }
  // Limited-time offer: the countdown's expiry instant, supplied per send. Goes
  // BEFORE the button components, matching Meta's example ordering.
  if (variables.limitedTimeOfferExpiresAtMs !== undefined) {
    components.push({
      type: "limited_time_offer",
      parameters: [
        {
          type: "limited_time_offer",
          // MILLISECONDS. The sibling analytics/compare endpoints take SECONDS —
          // mixing them up here doesn't error, it just renders a nonsense
          // countdown, so the unit is named everywhere it travels.
          limited_time_offer: {
            expiration_time_ms: variables.limitedTimeOfferExpiresAtMs,
          },
        },
      ],
    });
  }

  // Dynamic buttons (URL suffix / copy-code / quick-reply payload). Each is
  // its own `button` component keyed by `sub_type` + `index`. Static buttons
  // carry no parameter and are simply not listed here.
  for (const btn of variables.buttons ?? []) {
    components.push(buttonComponent(btn));
  }

  // Carousel cards. Each card is a mini-template — its own header parameter,
  // body parameters and button components — keyed by `card_index`. The array
  // must have exactly as many entries as the template was approved with.
  if (variables.cards && variables.cards.length > 0) {
    components.push({
      type: "carousel",
      cards: variables.cards.map((card, cardIndex) => {
        const cardComponents: Array<Record<string, unknown>> = [
          {
            type: "header",
            parameters: [
              {
                type: card.headerMedia.kind,
                // Meta's example uses an uploaded media id; a public link works
                // the same way it does for a top-level media header. Prefer the
                // id when both are present — it's the one Meta recommends,
                // since a link makes Meta fetch from our server per send.
                [card.headerMedia.kind]: card.headerMedia.id
                  ? { id: card.headerMedia.id }
                  : { link: card.headerMedia.link },
              },
            ],
          },
        ];
        if (card.body && card.body.length > 0) {
          cardComponents.push({
            type: "body",
            parameters: card.body.map((text) => ({ type: "text", text })),
          });
        }
        for (const btn of card.buttons ?? []) {
          cardComponents.push(buttonComponent(btn));
        }
        return { card_index: cardIndex, components: cardComponents };
      }),
    });
  }

  // Tap-target override, LAST: it is a whole-message affordance rather than a
  // parameter for any one component, and Meta's examples place it after the
  // content components.
  if (variables.tapTarget) {
    components.push({
      type: "tap_target_configuration",
      parameters: [
        {
          type: "tap_target_configuration",
          // Meta nests an ARRAY here even though only one entry is documented.
          tap_target_configuration: [
            { url: variables.tapTarget.url, title: variables.tapTarget.title },
          ],
        },
      ],
    });
  }

  return components;
}

// ---------------------------------------------------------------------------
// Template helpers — keep wire-shape parsing local to this file so the
// provider interface stays Meta-agnostic.
// ---------------------------------------------------------------------------

export interface MetaTemplateRow {
  id?: string;
  name?: string;
  language?: string;
  status?: string;
  category?: string;
  components?: TemplateComponent[];
  /** Meta's own answer: "POSITIONAL" | "NAMED". Absent on old rows. */
  parameter_format?: string;
  /** The category Meta has decided this template SHOULD be, when it disagrees
   *  with `category`. "" / absent = not impacted. See ProviderTemplate. */
  correct_category?: string;
  /** Delivery retry window. Meta returns it as a number; absent = category default. */
  message_send_ttl_seconds?: number;
  /** Quality band + when Meta last computed it. `date` is unix SECONDS. */
  quality_score?: { score?: string; date?: number };
  /** Present ONLY on templates created from the Template Library — the marker
   *  the doc keys send-time parameter TYPE checks on. */
  library_template_name?: string;
  /** True when button-click tracking was disabled on this template (the
   *  Analytics doc's per-template link-tracking opt-out). Absent on old rows. */
  cta_url_link_tracking_opted_out?: boolean;
}

/**
 * Did Meta accept this send but PARK it?
 *
 * Business-portfolio pacing batches template delivery so feedback can be
 * gathered between batches. Held messages get a real wamid, so the only signal
 * is `message_status` on the send response — and a caller that ignores it
 * reports a campaign as fully sent while most of it sits in Meta's queue.
 *
 * The Message API reference documents THREE accepted-response values:
 * `accepted`, `held_for_quality_assessment`, and `paused` ("the message
 * delivery has been paused"). Both non-accepted values mean the same thing to
 * a caller — accepted but parked, delivery not underway — so both map to the
 * `held` rung; only the operator copy would ever distinguish them.
 *
 * Applies to portfolios under 500k template sends in a rolling 365 days, and to
 * any portfolio under review for suspicious activity. Distinct from TEMPLATE
 * pacing, which pauses the template itself.
 */
export function isHeldForQualityAssessment(json: {
  messages?: Array<{ message_status?: string }>;
}): boolean {
  const status = json.messages?.[0]?.message_status;
  return status === "held_for_quality_assessment" || status === "paused";
}


/**
 * One `button` send component. Shared by top-level buttons and carousel-card
 * buttons, which take the identical shape — the card's `index` is scoped to
 * the card, not to the message.
 *
 * Note `index` is a STRING: Meta writes it both ways across its examples and
 * accepts either, so we emit one form everywhere rather than varying by
 * template kind.
 */
function buttonComponent(btn: {
  index: number;
  subType: "url" | "quick_reply" | "copy_code";
  text: string;
  paramName?: string;
}): Record<string, unknown> {
  const parameter =
    btn.subType === "copy_code"
      ? { type: "coupon_code", coupon_code: btn.text }
      : btn.subType === "quick_reply"
        ? { type: "payload", payload: btn.text }
        : {
            type: "text",
            // NAMED-format templates carry the URL variable's name — see
            // TemplateButtonParam.paramName. Positional templates omit it.
            // NOTE: `text` is sent VERBATIM. Percent-encoding of dynamic-URL
            // values happens in send-template-internal, which can tell a
            // genuine URL suffix apart from an authentication OTP code —
            // both arrive here as sub_type "url", and Meta's auth example
            // sends the code raw.
            ...(btn.paramName ? { parameter_name: btn.paramName } : {}),
            text: btn.text,
          };
  return {
    type: "button",
    sub_type: btn.subType,
    index: String(btn.index),
    parameters: [parameter],
  };
}

/**
 * Component types Meta's docs only ever write in lower snake_case. Sending the
 * uppercase form is an unverified gamble, so they are lowered on the way out —
 * including a carousel's NESTED card components, which the create example shows
 * as `"type": "header"` / `"buttons"` / `"body"`.
 */
const LOWERCASE_ON_CREATE = new Set([
  "CALL_PERMISSION_REQUEST",
  "LIMITED_TIME_OFFER",
  "CAROUSEL",
]);

export function lowercaseComponentForCreate(c: TemplateComponent): TemplateComponent {
  const type = LOWERCASE_ON_CREATE.has(c.type) ? c.type.toLowerCase() : c.type;
  if (!c.cards) return { ...c, type } as TemplateComponent;
  return {
    ...c,
    type,
    cards: c.cards.map((card) => ({
      ...card,
      components: (card.components ?? []).map((cc) => ({
        ...cc,
        // Nested types AND formats are lowercase in Meta's carousel example.
        type: cc.type.toLowerCase(),
        ...(cc.format ? { format: cc.format.toLowerCase() } : {}),
        ...(cc.buttons
          ? { buttons: cc.buttons.map((b) => ({ ...b, type: b.type.toLowerCase() })) }
          : {}),
      })),
    })),
  } as TemplateComponent;
}

/**
 * Uppercase a component's `type`, and recurse into a carousel's cards — their
 * nested components arrive in the same mixed casing.
 */
function normalizeComponentCasing<T extends { type?: unknown; cards?: unknown }>(
  c: T,
): T {
  if (!c || typeof c !== "object") return c;
  const type = typeof c.type === "string" ? c.type.toUpperCase() : c.type;
  const cards = Array.isArray(c.cards)
    ? c.cards.map((card: { components?: unknown }) =>
        card && typeof card === "object" && Array.isArray(card.components)
          ? { ...card, components: card.components.map(normalizeComponentCasing) }
          : card,
      )
    : c.cards;
  return { ...c, type, ...(cards === undefined ? {} : { cards }) } as T;
}

/**
 * Meta row → `ProviderTemplate`.
 *
 * Returns null ONLY when there is no identity to key on (no name/language).
 * An unmappable `status` or `category` yields a row with that field `null`
 * rather than dropping the whole template: the catalog sync prunes local rows
 * Meta didn't return, so a dropped row was indistinguishable from a deleted one
 * and the template — plus the `variableBindings` we own — was destroyed. That is
 * not hypothetical: `LIMIT_EXCEEDED` is a documented status, so hitting the WABA
 * template cap used to delete templates out of the app.
 */
export function normalizeMetaTemplate(row: MetaTemplateRow): ProviderTemplate | null {
  if (!row.name || !row.language) return null;
  const status = mapTemplateStatus(row.status);
  const category = mapTemplateCategory(row.category);
  // Meta returns component types uppercase EXCEPT the ones whose docs only ever
  // show them lowercase (`call_permission_request`, `limited_time_offer`,
  // `carousel`). Normalize on the way in so every downstream reader can compare
  // against one casing — a `c.type === "CAROUSEL"` check that silently never
  // matches is the kind of bug that only shows up at send time.
  const components = (Array.isArray(row.components) ? row.components : []).map(
    normalizeComponentCasing,
  );
  const body = components.find((c) => c.type === "BODY");
  return {
    name: row.name,
    language: row.language,
    status,
    category,
    // Meta returns "" (not null) for "not impacted", which `mapTemplateCategory`
    // already turns into null.
    correctCategory: mapTemplateCategory(row.correct_category),
    // Passed through verbatim — an unmapped band is informational, so storing
    // what Meta said beats dropping it. `date` is unix SECONDS (the same trap
    // as every other Meta timestamp on this surface).
    ...(row.quality_score?.score ? { qualityScore: row.quality_score.score } : {}),
    ...(typeof row.quality_score?.date === "number"
      ? { qualityScoreAt: new Date(row.quality_score.date * 1000) }
      : {}),
    bodyText: body?.text ?? "",
    components,
    // Default POSITIONAL when Meta omits it: that is the historical default and
    // the shape every pre-existing row was synced under, so an omitted field
    // can't silently flip a working template to the named wire format.
    parameterFormat: (row.parameter_format ?? "").toUpperCase() === "NAMED" ? "named" : "positional",
    ...(typeof row.message_send_ttl_seconds === "number"
      ? { messageSendTtlSeconds: row.message_send_ttl_seconds }
      : {}),
    ...(row.library_template_name ? { libraryTemplateName: row.library_template_name } : {}),
    // Only when Meta actually reported it — absent must leave the stored value
    // alone (same never-prune discipline as every other field here).
    ...(typeof row.cta_url_link_tracking_opted_out === "boolean"
      ? { linkTrackingOptedOut: row.cta_url_link_tracking_opted_out }
      : {}),
    ...(row.id ? { externalId: row.id } : {}),
  };
}

const PARAM_TYPES = new Set<string>([
  "ADDRESS",
  "TEXT",
  "AMOUNT",
  "DATE",
  "PHONE_NUMBER",
  "EMAIL",
  "NUMBER",
]);

/**
 * One library-catalogue row → `LibraryTemplate`.
 *
 * Null only when there is no name or body to work with. An unmappable category
 * is kept as null rather than dropping the blueprint — the same reasoning as
 * `normalizeMetaTemplate`: hiding a template because ONE field was unfamiliar is
 * a worse answer than showing it with a gap.
 */
export function normalizeLibraryTemplate(raw: unknown): LibraryTemplate | null {
  if (!isObject(raw)) return null;
  const row = raw as Record<string, unknown>;
  const name = typeof row.name === "string" ? row.name : "";
  const body = typeof row.body === "string" ? row.body : "";
  if (!name || !body) return null;

  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

  return {
    name,
    language: typeof row.language === "string" ? row.language : "",
    category: mapTemplateCategory(typeof row.category === "string" ? row.category : undefined),
    ...(typeof row.topic === "string" ? { topic: row.topic } : {}),
    ...(typeof row.usecase === "string" ? { usecase: row.usecase } : {}),
    industry: strings(row.industry),
    ...(typeof row.header === "string" ? { header: row.header } : {}),
    body,
    ...(typeof row.footer === "string" ? { footer: row.footer } : {}),
    bodyParams: strings(row.body_params),
    // Drop anything outside Meta's documented set rather than passing an unknown
    // type through to a send-time validator that would not know what to do
    // with it.
    bodyParamTypes: strings(row.body_param_types)
      .map((t) => t.toUpperCase().replace(/\s+/g, "_"))
      .filter((t): t is TemplateParamType => PARAM_TYPES.has(t)),
    buttons: Array.isArray(row.buttons)
      ? row.buttons.filter(isObject).map((b) => {
          const btn = b as Record<string, unknown>;
          return {
            type: typeof btn.type === "string" ? btn.type : "",
            ...(typeof btn.text === "string" ? { text: btn.text } : {}),
            ...(typeof btn.url === "string" ? { url: btn.url } : {}),
            ...(typeof btn.phone_number === "string"
              ? { phone_number: btn.phone_number }
              : {}),
          };
        })
      : [],
    ...(typeof row.id === "string" ? { id: row.id } : {}),
  };
}

export function mapTemplateStatus(s: string | undefined): TemplateStatus | null {
  switch ((s ?? "").toUpperCase()) {
    // REINSTATED = Meta re-enabled a previously disabled/paused/flagged template;
    // it "can be sent again" (doc). Without it the row stays locally un-sendable
    // and broadcasts keep skipping it until a manual Sync.
    case "APPROVED":
    case "REINSTATED":
      return "approved";
    case "PENDING":
    case "IN_APPEAL":
      return "pending";
    case "REJECTED":
      return "rejected";
    // A FLAGGED template can't be sent — treat like paused so it's not offered.
    // LIMIT_EXCEEDED is "paused due to template pacing" (current status
    // reference) — it does NOT recover on its own; the documented recovery is
    // the manual /unpause the app already exposes, which is exactly the
    // "paused" surface. (An older reading — "WABA at its template cap, clears
    // itself" — was superseded; the mapping was right, the reason wasn't.)
    case "PAUSED":
    case "FLAGGED":
    case "LIMIT_EXCEEDED":
      return "paused";
    // PENDING_DELETION is "deleted via WhatsApp Manager" (webhook reference),
    // not a review state — it used to map to `pending`, which rendered a
    // template on its way OUT as one on its way IN.
    case "DISABLED":
    case "DELETED":
    case "PENDING_DELETION":
      return "disabled";
    // Its own state, NOT `disabled`. An archived template is recoverable for 28
    // days and then deleted for good — collapsing it into `disabled` hid both
    // the escape hatch and the deadline.
    case "ARCHIVED":
      return "archived";
    // LOCKED (status-update webhook: "the template has been locked and cannot
    // be edited", with other_info carrying the lock reason) is DELIBERATELY
    // unmapped: it changes editability, not sendability, and nothing here
    // models edit-locks — null leaves the stored sendability status alone,
    // which is the leave-stored-value posture this mapper is built on.
    default:
      return null;
  }
}

export function mapTemplateCategory(c: string | undefined): TemplateCategory | null {
  switch ((c ?? "").toUpperCase()) {
    case "MARKETING":
      return "marketing";
    case "UTILITY":
    case "TRANSACTIONAL":
      return "utility";
    // OTP is the pre-2023 authentication category, still in the Graph enum —
    // same legacy-tolerance as its twin TRANSACTIONAL above.
    case "AUTHENTICATION":
    case "OTP":
      return "authentication";
    default:
      return null;
  }
}

// Template placeholder rendering/counting moved to @ccp/shared so the client
// optimistic preview can't drift from the server-stored body. Re-exported here
// so existing `@/lib/providers/meta` import sites keep working.
/**
 * Parse a `/compare` response.
 *
 * The payload is a list of metric envelopes discriminated by `metric`, each with
 * its own value shape. Read them by name rather than by position — the order is
 * not contractual, and an unknown metric is ignored rather than shifting the
 * others.
 */
export function parseTemplateComparison(json: unknown): ProviderTemplateComparison {
  const out: ProviderTemplateComparison = {
    blockRateOrder: [],
    sends: [],
    topBlockReasons: [],
  };
  const data = (json as { data?: unknown })?.data;
  if (!Array.isArray(data)) return out;

  for (const raw of data) {
    if (!isObject(raw)) continue;
    const entry = raw as {
      metric?: unknown;
      order_by_relative_metric?: unknown;
      number_values?: unknown;
      string_values?: unknown;
    };
    switch (entry.metric) {
      case "BLOCK_RATE":
        if (Array.isArray(entry.order_by_relative_metric)) {
          out.blockRateOrder = entry.order_by_relative_metric.filter(
            (v): v is string => typeof v === "string",
          );
        }
        break;
      case "MESSAGE_SENDS":
        if (Array.isArray(entry.number_values)) {
          for (const kv of entry.number_values) {
            if (!isObject(kv)) continue;
            const { key, value } = kv as { key?: unknown; value?: unknown };
            if (typeof key === "string" && typeof value === "number") {
              out.sends.push({ templateExternalId: key, count: value });
            }
          }
        }
        break;
      case "TOP_BLOCK_REASON":
        if (Array.isArray(entry.string_values)) {
          for (const kv of entry.string_values) {
            if (!isObject(kv)) continue;
            const { key, value } = kv as { key?: unknown; value?: unknown };
            if (typeof key === "string" && typeof value === "string") {
              out.topBlockReasons.push({ templateExternalId: key, reason: value });
            }
          }
        }
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * Parse Meta's `template_analytics` response into flat template-day rows.
 *
 * The shape is awkward and has moved: the payload is sometimes
 * `{ template_analytics: { data: [ { data_points: [...] } ] } }` and sometimes
 * `{ template_analytics: [ { data_points: [...] } ] }`. Both are handled rather
 * than picking one, because guessing wrong yields an empty array that is
 * indistinguishable from "this template genuinely sent nothing".
 *
 * NULL DISCIPLINE is the load-bearing part. Meta returns READ and CLICKED only
 * for the last ~7 days (then RESETS them to zero), and omits COST entirely for
 * Solution-Partner-billed WABAs. An absent metric becomes `null` — never 0 —
 * so the storage layer's merge (GREATEST for counts, COALESCE for the rest)
 * never overwrites a captured number with a later blank or reset.
 */
export function parseTemplateAnalytics(json: {
  template_analytics?: unknown;
}): ProviderTemplateAnalyticsRow[] {
  const ta = json.template_analytics;
  const groups: unknown[] = Array.isArray(ta)
    ? ta
    : ta && typeof ta === "object" && Array.isArray((ta as { data?: unknown }).data)
      ? ((ta as { data: unknown[] }).data)
      : [];

  const out: ProviderTemplateAnalyticsRow[] = [];
  for (const group of groups) {
    const points = (group as { data_points?: unknown }).data_points;
    if (!Array.isArray(points)) continue;
    for (const raw of points) {
      const pt = raw as Record<string, unknown>;
      const templateExternalId = str(pt.template_id);
      const startSec = num(pt.start);
      if (!templateExternalId || startSec === null) continue;

      const cost = pt.cost;
      let amountSpent: number | null = null;
      let perDelivered: number | null = null;
      let perUrlClick: number | null = null;
      let currency: string | null = null;
      // `cost` is an ARRAY of typed entries, and it is absent (not zero) when
      // Meta withholds pricing. The type tag's CASE has been seen both ways —
      // Meta's own doc example says `amount_spent`, older captures said
      // `AMOUNT_SPENT` — so match case-insensitively; picking one silently
      // nulls every cost figure when the other arrives.
      if (Array.isArray(cost)) {
        for (const entry of cost) {
          const e = entry as Record<string, unknown>;
          const type = str(e.type)?.toUpperCase() ?? null;
          const value = num(e.value);
          currency = str(e.currency) ?? currency;
          if (type === "AMOUNT_SPENT") amountSpent = value;
          else if (type === "COST_PER_DELIVERED") perDelivered = value;
          else if (type === "COST_PER_URL_BUTTON_CLICK") perUrlClick = value;
        }
      }

      // `clicked` is an ARRAY of per-button entries
      // (`{ type, button_content, count }`), NOT a scalar — treating it as one
      // parses every buttoned template's clicks to null. The scalar we store is
      // "link clicks": unique URL-button clicks when Meta reports them, total
      // URL clicks otherwise. Quick-reply presses stay out of the scalar (they
      // arrive as inbound replies and the funnel already counts them) but are
      // kept in the breakdown.
      const clickedRaw = pt.clicked;
      let clicked: number | null = null;
      let clickedButtons: TemplateButtonClicks[] | null = null;
      if (Array.isArray(clickedRaw)) {
        const entries: TemplateButtonClicks[] = [];
        for (const entry of clickedRaw) {
          const e = entry as Record<string, unknown>;
          const type = str(e.type)?.toLowerCase();
          const count = num(e.count);
          if (!type || count === null) continue;
          entries.push({ type, buttonContent: str(e.button_content), count });
        }
        const sumOf = (t: string): number | null => {
          const hits = entries.filter((e) => e.type === t);
          return hits.length ? hits.reduce((a, e) => a + e.count, 0) : null;
        };
        clicked = sumOf("unique_url_button") ?? sumOf("url_button");
        // An all-zero breakdown is ambiguous: a fresh campaign nobody clicked,
        // or the post-7-day reset (Meta zeroes clicks, it doesn't omit them).
        // Store null so the COALESCE merge can't erase a captured breakdown;
        // the scalar's GREATEST merge preserves a genuine zero either way.
        const anyCount = entries.some((e) => e.count > 0);
        clickedButtons = anyCount ? entries : null;
      } else {
        // Tolerate a plain number — the shape this parser originally assumed.
        clicked = num(clickedRaw);
      }

      out.push({
        templateExternalId,
        // Meta reports UNIX SECONDS; the day boundary is the window start.
        date: new Date(startSec * 1000),
        sent: num(pt.sent) ?? 0,
        delivered: num(pt.delivered) ?? 0,
        // Absent = not reported (outside the 7-day window), NOT zero.
        read: num(pt.read),
        clicked,
        clickedButtons,
        costAmountSpent: amountSpent,
        costPerDelivered: perDelivered,
        costPerUrlClick: perUrlClick,
        currency,
      });
    }
  }
  return out;
}

export function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** `num` with a 0 floor, for the window bounds every data point always carries. */
export function numOrZero(v: unknown): number {
  return num(v) ?? 0;
}

/** Meta's analytics timestamps are UNIX SECONDS. Passing milliseconds returns an
 *  EMPTY set rather than an error, which reads as "no data" forever. */
export function unixSeconds(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}

/**
 * One filter for the field-expansion form: `.name(A,B,C)`.
 *
 * Graph accepts the bare comma list, the bracketed list and the bracketed-quoted
 * list INTERCHANGEABLY here; bare is chosen for brevity, and there is nothing to
 * fix. Investigated 2026-07-30 because Meta's analytics page is internally
 * inconsistent — the same page writes
 * `.dimensions(["CONVERSATION_CATEGORY","CONVERSATION_TYPE"])`,
 * `.dimensions([CONVERSATION_TYPE])` and
 * `.dimensions(PRICING_CATEGORY,PRICING_TYPE,TIER,COUNTRY)` — which looks like a
 * per-field wire contract and is not one.
 *
 * What settles it: the Graph reference for `conversation_analytics` declares ONE
 * schema (`array<enum {...}>`) and then auto-generates the SAME request two ways —
 * its cURL tab emits a bare comma list while its Android and Objective-C tabs emit
 * the bracketed-quoted form. One schema, two serialisers ⇒ the inconsistency is
 * authorship, not semantics. Third-party production integrations also send bare
 * lists to `conversation_analytics`, the field Meta only ever documents bracketed.
 *
 * This note is deliberately explicit because the previous wording ("Meta's own guide
 * examples write these as BARE comma lists, not JSON arrays") implied the bracketed
 * form was WRONG — which is exactly what tempts a well-meaning contributor to
 * "correct" this back and forth on the strength of whichever example they read last.
 *
 * An empty or absent list is omitted entirely rather than sent as `()` — Meta
 * documents an empty list as "return everything", which is what omitting does,
 * and `()` is a parse error on some fields.
 */
export function graphListArg(name: string, values?: Array<string | number>): string {
  if (!values || values.length === 0) return "";
  return `.${name}(${values.join(",")})`;
}

/** The same filter for the EDGE form, where array params are JSON-encoded. */
export function graphJsonParam(
  name: string,
  values?: Array<string | number>,
): Record<string, string> {
  if (!values || values.length === 0) return {};
  return { [name]: JSON.stringify(values) };
}

/**
 * Pull the `data_points` out of any shape Meta uses for an analytics response.
 *
 * There are four documented shapes across the seven analytics fields, and they
 * are not interchangeable:
 *   - `{ <field>: { data: [ { data_points: [...] } ] } }` — conversation, pricing
 *   - `{ <field>: { data_points: [...] } }`               — messaging `analytics`
 *   - `{ data: [ { data_points: [...] } ] }`              — the edge form
 *   - `{ data_points: [...] }`
 * Handling all four in one place beats picking one per call site: guessing wrong
 * yields an empty array, which is indistinguishable from "this account sent
 * nothing" and would be reported to the user as exactly that.
 */
export function analyticsDataPoints(
  json: unknown,
  field: string,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj.data_points)) {
      for (const pt of obj.data_points) {
        if (pt && typeof pt === "object" && !Array.isArray(pt)) {
          out.push(pt as Record<string, unknown>);
        }
      }
    }
    if (Array.isArray(obj.data)) obj.data.forEach(visit);
  };
  const root = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
  // The named wrapper first (field form), then the bare one (edge form).
  visit(root[field]);
  if (Array.isArray(root[field])) (root[field] as unknown[]).forEach(visit);
  visit(root);
  return out;
}

/**
 * Split Meta's `"<LOWER>:<UPPER>"` volume-tier bound.
 *
 * `UPPER` is either an integer or the literal `MAX`. `MAX` becomes null rather
 * than a sentinel number: the caller's question is "how far to the next tier",
 * and on an unbounded tier the honest answer is "there isn't one" — a huge
 * placeholder would render as a reachable target.
 */
export function parseTierBounds(tier: string | null): {
  lower: number | null;
  upper: number | null;
} {
  if (!tier) return { lower: null, upper: null };
  const [rawLower, rawUpper] = tier.split(":");
  const lower = num(rawLower);
  const upper = rawUpper && rawUpper.toUpperCase() !== "MAX" ? num(rawUpper) : null;
  return { lower, upper };
}



export function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
