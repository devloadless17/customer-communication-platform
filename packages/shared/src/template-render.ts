/**
 * WhatsApp template placeholder rendering — SINGLE SOURCE OF TRUTH.
 *
 * Used by the server (send-template-internal + broadcast-runner, which store
 * the RENDERED body on the message row) and the client (the reply-box
 * optimistic preview + the template picker). Keeping one copy means the
 * optimistic bubble can't drift from what actually gets persisted/sent — the
 * same reason `mediaPreviewLabel` lives in shared.
 */

/**
 * Render a template body for preview/storage by substituting `{{n}}`
 * placeholders with positional values. Missing/empty positions are left as
 * `{{n}}` so an agent can spot the one they forgot before sending.
 */
export function renderTemplateBody(text: string, vars: string[]): string {
  return text.replace(/\{\{(\d+)\}\}/g, (_match, idxStr) => {
    const idx = Number(idxStr) - 1;
    const v = vars[idx];
    return v && v.length > 0 ? v : `{{${idxStr}}}`;
  });
}

/**
 * Highest `{{n}}` placeholder index in a template body (0 if none). Drives
 * variable-count validation. Ignores gaps — `"Hi {{1}}, see {{3}}"` returns 3,
 * matching Meta's rule that you must supply 1..N consecutively.
 */
export function countTemplatePlaceholders(text: string): number {
  let max = 0;
  const re = /\{\{(\d+)\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

/**
 * Placeholder names of a NAMED-format template body (`parameter_format: NAMED`,
 * `"Hi {{name}}, order {{order_id}} shipped"` → `["name", "order_id"]`), in
 * first-appearance order and de-duplicated.
 *
 * A named placeholder starts with a letter or underscore, which is exactly what
 * distinguishes it from the positional `{{1}}` form — so the two counters never
 * both fire on the same body. Without this, a NAMED body scored 0 positional
 * placeholders, validation happily accepted zero variables, and Meta rejected
 * the send for missing body parameters with nothing actionable in the error.
 */
export function templateNamedPlaceholders(text: string): string[] {
  const seen = new Set<string>();
  const re = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    if (name) seen.add(name);
  }
  return [...seen];
}

/**
 * Render a NAMED-format body for preview/storage. Unsupplied names are left as
 * `{{name}}`, mirroring {@link renderTemplateBody}'s positional behavior.
 */
export function renderTemplateBodyNamed(
  text: string,
  vars: ReadonlyArray<{ name: string; text: string }>,
): string {
  const byName = new Map(vars.map((v) => [v.name, v.text]));
  return text.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (match, name: string) => {
    const v = byName.get(name);
    return v && v.length > 0 ? v : match;
  });
}

/** A send-time parameter a template's BUTTONS component demands. */
export interface RequiredTemplateButtonParam {
  index: number;
  subType: "url" | "copy_code";
  /**
   * The URL variable's name for a NAMED-format template (`{{token}}` in the
   * stored URL). Meta's send payload requires `parameter_name` on the button
   * parameter for named templates; absent for positional (`{{1}}`) URLs.
   */
  paramName?: string;
  /**
   * True for an authentication template's OTP button, whose value is by
   * definition the SAME verification code already in the body.
   *
   * The send path fills it from `body[0]` rather than asking twice: Meta's own
   * examples put one code in both places, and prompting an agent to retype it is
   * an invitation to send a message whose button copies a different code than the
   * text shows.
   */
  autofillFromBody?: boolean;
}

/**
 * Which buttons on a template REQUIRE a send-time parameter, read from the
 * `components` array exactly as Meta returned it.
 *
 * Only two button kinds are unambiguous:
 *   - a URL button whose url contains a `{{n}}` suffix placeholder, and
 *   - a COPY_CODE (coupon) button.
 * Both are rejected by Meta when sent without their parameter, so surfacing them
 * up front strictly improves on the status quo.
 *
 * QUICK_REPLY is deliberately NOT reported: its payload is optional on the wire,
 * and demanding one would break templates that send correctly today. Static URL
 * buttons (no placeholder) carry no parameter either.
 */
export function requiredTemplateButtonParams(
  components: unknown,
  /**
   * The template's category. Load-bearing for authentication templates — see
   * the OTP branch below, which cannot be identified from the button alone.
   */
  category?: string,
): RequiredTemplateButtonParam[] {
  if (!Array.isArray(components)) return [];
  const isAuth = category === "authentication";
  const required: RequiredTemplateButtonParam[] = [];
  for (const raw of components) {
    if (typeof raw !== "object" || raw === null) continue;
    const comp = raw as { type?: unknown; buttons?: unknown };
    if (typeof comp.type !== "string" || comp.type.toUpperCase() !== "BUTTONS") continue;
    if (!Array.isArray(comp.buttons)) continue;
    comp.buttons.forEach((b, index) => {
      if (typeof b !== "object" || b === null) return;
      const btn = b as { type?: unknown; url?: unknown };
      const type = typeof btn.type === "string" ? btn.type.toUpperCase() : "";
      // NOTE: `otp_type` is deliberately NOT consulted. All three variants —
      // one-tap, zero-tap and copy-code — have identical send payloads in Meta's
      // docs, so branching on it only creates ways to be wrong (this code has
      // already been wrong twice that way: excluding zero-tap, then sending
      // `copy_code` for copy-code authentication).
      // ── Authentication templates ──────────────────────────────────────
      // Their button ALWAYS carries the verification code — Meta's own send
      // example puts the same code in the body and the button, noting "this
      // value must appear twice in the payload". Omitting it makes the send
      // fail, which is why authentication templates did not work at all.
      //
      // The button CANNOT be identified by its type. Meta's docs are explicit:
      // "in your template creation request the button type is designated as
      // `otp`, but upon creation the button type will be set to `url`" — so a
      // synced one-tap template reads as a URL button with no `{{n}}` in its
      // url, matching neither the OTP nor the dynamic-URL branch below. The
      // CATEGORY is the only reliable discriminator.
      // `type === "OTP"` is unambiguous on its own — that type exists ONLY on an
      // authentication template — so it is honoured even when the caller didn't
      // pass a category. The category is what rescues the OTHER case: a button
      // Meta has already rewritten to `url`.
      if (isAuth || type === "OTP") {
        // EVERY otp_type needs the code on the button, ZERO_TAP included.
        //
        // "No button at all" in Meta's overview describes what the USER SEES,
        // not the payload: a zero-tap template still declares one-tap and
        // copy-code buttons "even if the user may never see one of these", so
        // that a failed eligibility check can fall back to them — and the
        // fallback needs the code. Meta's zero-tap SEND example is byte-identical
        // to one-tap's, `sub_type: "url"` and all. Excluding ZERO_TAP (as this
        // did) left those templates sent body-only and rejected.
        required.push({
          index,
          // ALWAYS `url`, for every otp_type — one-tap, zero-tap AND copy-code.
          //
          // This is counter-intuitive: a copy-code AUTHENTICATION button does
          // NOT use the `copy_code` sub-type that a marketing coupon button
          // uses. All three of Meta's authentication send examples are identical
          // and all specify `sub_type: "url"`, which follows from Meta rewriting
          // every otp button to type `url` on creation. Sending `copy_code` here
          // (as this did) is rejected.
          //
          // The `copy_code` sub-type below still applies to a real coupon button
          // on a marketing/utility template — a different thing that happens to
          // share a name.
          subType: "url",
          autofillFromBody: true,
        });
        return;
      }

      if (type === "COPY_CODE") {
        required.push({ index, subType: "copy_code" });
      } else if (type === "URL" && typeof btn.url === "string" && btn.url.includes("{{")) {
        // A NAMED-format template's URL variable is `{{token}}`, and Meta's
        // send payload then requires `parameter_name` on the button parameter
        // (its URL-encoding example shows exactly this shape). The name lives
        // ONLY in the stored URL, so it is read from there — this reads the
        // NAME, not the format: `parameterFormat` stays the sole authority on
        // positional-vs-named, and a numeric token (a positional `{{1}}`)
        // must never be emitted as a name.
        const token = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/.exec(btn.url)?.[1];
        const paramName = token && !/^\d+$/.test(token) ? token : undefined;
        required.push({ index, subType: "url", ...(paramName ? { paramName } : {}) });
      }
    });
  }
  return required;
}

// ---------------------------------------------------------------------------
// Meta field limits.
// ---------------------------------------------------------------------------

/**
 * The hard limits Meta enforces on a template's components, from the WhatsApp
 * Business "Template fundamentals" documentation.
 *
 * Enforced BEFORE the Graph call rather than letting Meta reject: a rejection
 * arrives as an opaque `#100 Invalid parameter` with no field name, so an
 * author who pasted a 1,200-character body learns only that "something" was
 * wrong. Checking here names the field and the number.
 *
 * These are Meta's numbers, not ours — do not tighten them to be "safe". A
 * limit stricter than the provider's silently blocks templates that would have
 * been accepted, which is indistinguishable from a bug.
 */
export const TEMPLATE_LIMITS = {
  /** `^[a-z0-9_]{1,512}$` — lowercase, digits and underscores only. */
  nameMaxLength: 512,
  bodyMaxLength: 1024,
  headerMaxLength: 60,
  footerMaxLength: 60,
  /** Every button type that HAS a label shares one cap. */
  buttonTextMaxLength: 25,
  /** The string a COPY_CODE button puts on the clipboard. */
  copyCodeExampleMaxLength: 20,
  urlMaxLength: 2000,
  phoneNumberMaxLength: 20,
  maxButtons: 10,
  maxQuickReplyButtons: 10,
  // Per-TYPE caps, not one combined "call to action" budget. Meta's components
  // doc caps URL buttons at 2 and phone-number buttons at 1 INDEPENDENTLY, so a
  // combined cap of 2 was wrong in both directions: it rejected the legal
  // `URL + URL + PHONE_NUMBER` and accepted the illegal `PHONE_NUMBER × 2`.
  maxUrlButtons: 2,
  maxPhoneNumberButtons: 1,
  maxCopyCodeButtons: 1,
  /**
   * Past this many buttons WhatsApp shows only the first two and collapses the
   * rest behind a "See all options" button. Advisory — used for a UI hint, never
   * to reject a template.
   */
  buttonsBeforeSeeAllOptions: 3,
  /**
   * An authentication template's one-time password/code, sent as the body's
   * single parameter (and mirrored onto the button). Meta's one-tap send
   * reference: "Maximum 15 characters."
   */
  authCodeMaxLength: 15,
} as const;

/**
 * A limited-time offer template's OWN limits, which are TIGHTER than the
 * general ones — the body caps at 600 rather than 1024, and the offer code at
 * 15 rather than the usual copy-code 20. Applying the general numbers to one of
 * these lets an author write a body Meta will reject.
 */
export const CAROUSEL_LIMITS = {
  /** Meta requires at least 2 cards — one card is just a media template. */
  minCards: 2,
  maxCards: 10,
  /** A card body is far tighter than the message body's 1024. */
  cardBodyMaxLength: 160,
  maxButtonsPerCard: 2,
} as const;

export const LIMITED_TIME_OFFER_LIMITS = {
  bodyMaxLength: 600,
  /** The heading above the countdown. */
  offerTextMaxLength: 16,
  /** The offer code itself, at creation and at send. */
  offerCodeMaxLength: 15,
} as const;

/** Header formats whose asset is uploaded at CREATE time as a `header_handle`. */
export const MEDIA_HEADER_FORMATS = ["IMAGE", "VIDEO", "GIF", "DOCUMENT"] as const;

/** Meta allows a LOCATION header only on these categories. */
export const LOCATION_HEADER_CATEGORIES = ["utility", "marketing"] as const;

export const TEMPLATE_NAME_PATTERN = /^[a-z0-9_]{1,512}$/;

export interface TemplateValidationIssue {
  /** `body` · `header` · `footer` · `name` · `buttons` — the field to highlight. */
  field: string;
  message: string;
}

interface ValidatableButton {
  type?: string;
  text?: string;
  url?: string;
  phone_number?: string;
  example?: unknown;
}

interface ValidatableComponent {
  type?: string;
  format?: string;
  text?: string;
  limited_time_offer?: { text?: string; has_expiration?: boolean };
  example?: {
    header_text?: unknown;
    body_text?: unknown;
    header_handle?: unknown;
    body_text_named_params?: unknown;
    header_text_named_params?: unknown;
  };
  buttons?: ValidatableButton[];
  cards?: Array<{ components?: ValidatableComponent[] }>;
}

// ---------------------------------------------------------------------------
// Parameter format.
// ---------------------------------------------------------------------------

/**
 * Which placeholder dialect a set of components is written in.
 *
 * `mixed` is a hard authoring error, not a preference: Meta stores ONE
 * `parameter_format` per template, so a body of `"Hi {{1}}, order {{order_id}}"`
 * cannot be expressed. Whichever format we declare, half the placeholders are
 * unfilled at send time and every recipient fails with error 132000.
 */
export type DetectedParameterFormat = "none" | "positional" | "named" | "mixed";

/** Every `{{n}}` index in a string, in appearance order (duplicates kept). */
export function positionalPlaceholderIndices(text: string): number[] {
  const out: number[] = [];
  const re = /\{\{\s*(\d+)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/**
 * The parameter format a template's own text implies.
 *
 * Scans every surface Meta lets carry a placeholder — header text, body text,
 * and URL button targets — because a template whose body is positional and whose
 * URL suffix is named is just as unsendable as a mixed body.
 *
 * This is for the AUTHORING path only. For a template that already exists at
 * Meta, the stored `parameterFormat` (Meta's own `parameter_format`) is the
 * authority and this function must not be used to second-guess it: a positional
 * template whose body contains the literal copy `{{order_id}}` reads as `named`
 * here, which is exactly the misread the stored column exists to prevent.
 */
export function detectParameterFormat(
  components: ReadonlyArray<unknown>,
): DetectedParameterFormat {
  const comps = asComponents(components);
  const texts: string[] = [];
  // Deliberately does NOT descend into a carousel's cards. A card's URL button
  // variable is always written `{{1}}` regardless of the template's dialect, so
  // scanning them would read a NAMED template with cards as "mixed" and reject
  // a template Meta accepts.
  for (const c of comps) {
    if (c.type === "HEADER" && c.format === "TEXT" && c.text) texts.push(c.text);
    if (c.type === "BODY" && c.text) texts.push(c.text);
    if (c.type === "BUTTONS") {
      for (const b of c.buttons ?? []) {
        if (b.url) texts.push(b.url);
      }
    }
  }
  let positional = false;
  let named = false;
  for (const t of texts) {
    if (positionalPlaceholderIndices(t).length > 0) positional = true;
    if (templateNamedPlaceholders(t).length > 0) named = true;
  }
  if (positional && named) return "mixed";
  if (named) return "named";
  if (positional) return "positional";
  return "none";
}

function asComponents(components: ReadonlyArray<unknown>): ValidatableComponent[] {
  return components.filter(
    (c): c is ValidatableComponent => Boolean(c) && typeof c === "object",
  );
}

/** Meta writes a URL button's example as an array and a copy-code's as a bare
 *  string. Read both without letting either shape crash a validator. */
function exampleValues(example: unknown): string[] {
  if (typeof example === "string") return example.length > 0 ? [example] : [];
  if (Array.isArray(example)) return example.filter((v): v is string => typeof v === "string");
  return [];
}

/**
 * Check a template's name + components against Meta's limits.
 *
 * Pure, so the create form and the API share ONE definition of the rules — the
 * counter under the textarea and the server's rejection can't disagree about
 * what "too long" means.
 *
 * Returns every issue rather than the first, so an author fixes one form pass
 * instead of playing whack-a-mole with a 400 per field.
 */
export function validateTemplateComponents(
  name: string,
  components: ReadonlyArray<unknown>,
  options: { category?: string } = {},
): TemplateValidationIssue[] {
  const issues: TemplateValidationIssue[] = [];
  const push = (field: string, message: string) => issues.push({ field, message });

  if (!TEMPLATE_NAME_PATTERN.test(name)) {
    push(
      "name",
      "Name must be lowercase letters, digits and underscores only (up to 512 characters).",
    );
  }

  const comps = asComponents(components);

  // One of each — Meta rejects a second BODY/HEADER/FOOTER/BUTTONS outright.
  for (const type of [
    "HEADER",
    "BODY",
    "FOOTER",
    "BUTTONS",
    "CALL_PERMISSION_REQUEST",
    "LIMITED_TIME_OFFER",
    "CAROUSEL",
  ] as const) {
    const n = comps.filter((c) => c.type === type).length;
    if (n > 1) {
      push(type.toLowerCase(), `A template can have only one ${type} component — found ${n}.`);
    }
  }

  // A body of `"{{1}}"` alone, or of mixed dialects, cannot be declared under a
  // single parameter_format. Catch it before it becomes an opaque 132000.
  const format = detectParameterFormat(components);
  if (format === "mixed") {
    push(
      "body",
      "Mix of numbered ({{1}}) and named ({{order_id}}) variables. Meta stores one variable " +
        "format per template — use one style everywhere.",
    );
  }

  validateBody(comps, format, push);
  validateHeader(comps, format, options.category, push);
  validateFooter(comps, push);
  validateButtons(comps, push);
  validateCallPermissionRequest(comps, options.category, push);
  validateLimitedTimeOffer(comps, options.category, push);
  validateCarousel(comps, options.category, push);

  return issues;
}

/**
 * Does this template need a limited-time-offer expiry at send time?
 *
 * `has_expiration` is what makes WhatsApp render the countdown; with it false
 * the card shows the heading and code only and Meta expects NO expiry
 * parameter. Requiring one there refuses a send Meta accepts — the same
 * invisible failure as a too-tight length limit. Absent is read as true: our
 * own composer always sets it, and a template authored elsewhere that omits the
 * flag is one Meta defaults to showing the countdown for.
 */
export function templateNeedsOfferExpiry(
  components: ReadonlyArray<unknown>,
): boolean {
  const lto = asComponents(components).find((c) => c.type === "LIMITED_TIME_OFFER");
  return Boolean(lto) && lto?.limited_time_offer?.has_expiration !== false;
}

/**
 * What each carousel card needs supplied at SEND time.
 *
 * One authority for the send guard, the inbox fill view and the broadcast
 * composer — the card count is fixed at approval, so a UI that renders a
 * different number of cards than the send path demands is a guaranteed
 * whole-campaign failure.
 *
 * Returns an empty array for a template with no carousel.
 */
export function requiredCarouselCards(
  components: ReadonlyArray<unknown>,
): Array<{
  /** `image` or `video` — the card's header format, lowercased for the wire. */
  headerKind: "image" | "video";
  /** How many `{{n}}` the CARD body carries (0 when the cards have no body). */
  bodyVarCount: number;
  /** Buttons that need a value, indexed WITHIN the card. */
  buttons: Array<{ index: number; subType: "url" | "quick_reply" | "copy_code" }>;
}> {
  const carousel = asComponents(components).find((c) => c.type === "CAROUSEL");
  if (!carousel) return [];
  return (carousel.cards ?? []).map((card) => {
    const comps = asComponents(card.components ?? []);
    const header = comps.find((c) => c.type === "HEADER");
    const cardBody = comps.find((c) => c.type === "BODY");
    const buttons = comps.find((c) => c.type === "BUTTONS")?.buttons ?? [];
    return {
      headerKind:
        (header?.format ?? "").toUpperCase() === "VIDEO"
          ? ("video" as const)
          : ("image" as const),
      bodyVarCount: positionalPlaceholderIndices(cardBody?.text ?? "").length,
      buttons: buttons.flatMap<{
        index: number;
        subType: "url" | "quick_reply" | "copy_code";
      }>((b, index) => {
        const type = (b.type ?? "").toUpperCase();
        // A quick reply's payload is OPTIONAL (Meta: "Value to be included in
        // webhooks when the button is tapped") — it is offered, never demanded.
        if (type === "URL" && typeof b.url === "string" && b.url.includes("{{")) {
          return [{ index, subType: "url" }];
        }
        if (type === "COPY_CODE") return [{ index, subType: "copy_code" }];
        return [];
      }),
    };
  });
}

/**
 * Media-card carousels.
 *
 * The shape Meta will reject for is mostly about UNIFORMITY: every card is
 * rendered at one height in a horizontal scroller, so the cards must all carry
 * the same components. Meta reports each of these as an unlabelled `#100`, and
 * two of them are permanent: the CARD COUNT is fixed at approval (an approved
 * template can only ever send exactly that many cards), and so is each card's
 * component signature.
 */
function validateCarousel(
  comps: ValidatableComponent[],
  category: string | undefined,
  push: Push,
) {
  const carousel = comps.find((c) => c.type === "CAROUSEL");
  if (!carousel) return;

  if (category && category !== "marketing") {
    push("carousel", "Carousels are only allowed on marketing templates.");
  }
  // "Carousel templates consist of a message body text and up to 10 cards" —
  // the body is not optional here even though a media template's can be.
  if (!comps.some((c) => c.type === "BODY" && (c.text ?? "").trim().length > 0)) {
    push("carousel", "A carousel needs message body text above the cards.");
  }

  const cards = carousel.cards ?? [];
  if (cards.length < CAROUSEL_LIMITS.minCards || cards.length > CAROUSEL_LIMITS.maxCards) {
    push(
      "carousel",
      `A carousel needs between ${CAROUSEL_LIMITS.minCards} and ${CAROUSEL_LIMITS.maxCards} cards — found ${cards.length}.`,
    );
  }

  // Signature of card 0, which every other card must match.
  let signature: string | null = null;

  for (const [i, card] of cards.entries()) {
    const label = `Card ${i + 1}`;
    const cardComps = asComponents(card.components ?? []);
    const header = cardComps.find((c) => c.type === "HEADER");
    const cardBody = cardComps.find((c) => c.type === "BODY");
    const cardButtons = cardComps.find((c) => c.type === "BUTTONS");

    const fmt = (header?.format ?? "").toUpperCase();
    if (!header) {
      push("carousel", `${label} needs an image or video header.`);
    } else if (fmt !== "IMAGE" && fmt !== "VIDEO") {
      push("carousel", `${label}'s header must be an image or a video.`);
    } else if (!exampleValues(header.example?.header_handle)[0]) {
      push("carousel", `${label}'s header needs an uploaded media example.`);
    }

    const bodyText = cardBody?.text ?? "";
    if (bodyText.length > CAROUSEL_LIMITS.cardBodyMaxLength) {
      push(
        "carousel",
        `${label}'s body is ${bodyText.length} characters — a card caps at ${CAROUSEL_LIMITS.cardBodyMaxLength}.`,
      );
    }

    const buttons = cardButtons?.buttons ?? [];
    if (buttons.length > CAROUSEL_LIMITS.maxButtonsPerCard) {
      push(
        "carousel",
        `${label} has ${buttons.length} buttons — a card allows at most ${CAROUSEL_LIMITS.maxButtonsPerCard}.`,
      );
    }
    for (const [bi, b] of buttons.entries()) {
      const type = (b.type ?? "").toUpperCase();
      if (type === "URL" && typeof b.url === "string" && b.url.includes("{{")) {
        // Same suffix rule as a top-level URL button: the variable must be the
        // LAST thing in the URL, and it needs an example.
        if (!b.url.trimEnd().endsWith("}}")) {
          push("carousel", `${label} button ${bi + 1}: the URL variable must be at the end.`);
        }
        if (!exampleValues(b.example)[0]) {
          push("carousel", `${label} button ${bi + 1}: a URL variable needs an example.`);
        }
      }
    }

    // "All cards defined on a template must have the same components." The
    // signature covers what Meta actually renders on: which components exist,
    // the header format, whether there is body text, and the button types in
    // order (the send payload indexes buttons by position, so order is part of
    // the contract, not a detail).
    const cardSignature = JSON.stringify({
      header: header ? fmt : null,
      body: bodyText.length > 0,
      buttons: buttons.map((b) => (b.type ?? "").toUpperCase()),
    });
    if (signature === null) {
      signature = cardSignature;
    } else if (cardSignature !== signature) {
      push(
        "carousel",
        `${label} doesn't match card 1 — every card must have the same header format, the same body-or-no-body, and the same buttons in the same order.`,
      );
    }
  }
}

/**
 * Limited-time offer templates carry a countdown and have their own rule set,
 * every one of which Meta reports as an unlabelled `#100`:
 *   - MARKETING only;
 *   - NO footer component at all;
 *   - header must be IMAGE or VIDEO (no text, document or location);
 *   - the body caps at 600 characters, not the usual 1024;
 *   - the heading text caps at 16, and the offer code at 15 (not 20).
 */
function validateLimitedTimeOffer(
  comps: ValidatableComponent[],
  category: string | undefined,
  push: Push,
) {
  const lto = comps.find((c) => c.type === "LIMITED_TIME_OFFER");
  if (!lto) return;

  if (category && category !== "marketing") {
    push(
      "limited_time_offer",
      "A limited-time offer is only allowed on marketing templates.",
    );
  }
  if (comps.some((c) => c.type === "FOOTER")) {
    push(
      "limited_time_offer",
      "A limited-time offer template can't have a footer — the countdown occupies that space.",
    );
  }

  const header = comps.find((c) => c.type === "HEADER");
  const headerFormat = (header?.format ?? "").toUpperCase();
  if (header && headerFormat !== "IMAGE" && headerFormat !== "VIDEO") {
    push(
      "limited_time_offer",
      "A limited-time offer header must be an image or a video.",
    );
  }

  const bodyText = comps.find((c) => c.type === "BODY")?.text ?? "";
  if (bodyText.length > LIMITED_TIME_OFFER_LIMITS.bodyMaxLength) {
    push(
      "body",
      `A limited-time offer body is ${bodyText.length} characters — the limit is ` +
        `${LIMITED_TIME_OFFER_LIMITS.bodyMaxLength}, tighter than the usual ` +
        `${TEMPLATE_LIMITS.bodyMaxLength}.`,
    );
  }

  const offerText = lto.limited_time_offer?.text ?? "";
  if (offerText.trim().length === 0) {
    push("limited_time_offer", "Give the offer a short heading.");
  } else if (offerText.length > LIMITED_TIME_OFFER_LIMITS.offerTextMaxLength) {
    push(
      "limited_time_offer",
      `The offer heading is ${offerText.length} characters — the limit is ` +
        `${LIMITED_TIME_OFFER_LIMITS.offerTextMaxLength}.`,
    );
  }

  // The copy-code button on one of these carries the OFFER code, capped tighter
  // than a general coupon button.
  const buttons = comps.find((c) => c.type === "BUTTONS")?.buttons ?? [];
  for (const [i, b] of buttons.entries()) {
    if ((b.type ?? "").toUpperCase() !== "COPY_CODE") continue;
    const code = exampleValues(b.example)[0] ?? "";
    if (code.length > LIMITED_TIME_OFFER_LIMITS.offerCodeMaxLength) {
      push(
        "buttons",
        `Button ${i + 1} offer code is ${code.length} characters — a limited-time ` +
          `offer caps it at ${LIMITED_TIME_OFFER_LIMITS.offerCodeMaxLength}.`,
      );
    }
  }
}

/** Meta allows a call-permission request only on these categories. */
export const CALL_PERMISSION_CATEGORIES = ["marketing", "utility"] as const;

/**
 * A call-permission-request template asks the recipient for permission to CALL
 * them, and is the only way to ask outside the 24-hour window.
 *
 * Its two rules both produce an opaque Meta rejection, so they are checked here:
 * the category must be marketing or utility, and the component cannot be
 * combined with any other interactive component — which in practice means no
 * buttons, since Allow/Deny already occupy that role in the rendered message.
 */
function validateCallPermissionRequest(
  comps: ValidatableComponent[],
  category: string | undefined,
  push: Push,
) {
  if (!comps.some((c) => c.type === "CALL_PERMISSION_REQUEST")) return;

  if (
    category &&
    !CALL_PERMISSION_CATEGORIES.includes(category as "marketing" | "utility")
  ) {
    push(
      "call_permission_request",
      `A call-permission request is only allowed on ${CALL_PERMISSION_CATEGORIES.join(
        " or ",
      )} templates.`,
    );
  }
  if ((comps.find((c) => c.type === "BUTTONS")?.buttons ?? []).length > 0) {
    push(
      "call_permission_request",
      "A call-permission request can't be combined with buttons — the message " +
        "already renders its own Allow and Deny options.",
    );
  }
  // Meta's limitation is wider than buttons: "cannot be combined with other
  // interactive components". A carousel's cards carry buttons and a
  // limited-time offer renders its own tappable code chip — both are
  // interactive surfaces competing with the Allow/Deny prompt.
  if (comps.some((c) => c.type === "CAROUSEL")) {
    push(
      "call_permission_request",
      "A call-permission request can't be combined with a carousel — Meta allows " +
        "no other interactive components alongside it.",
    );
  }
  if (comps.some((c) => c.type === "LIMITED_TIME_OFFER")) {
    push(
      "call_permission_request",
      "A call-permission request can't be combined with a limited-time offer — " +
        "Meta allows no other interactive components alongside it.",
    );
  }
  const body = comps.find((c) => c.type === "BODY");
  if (!body?.text?.trim()) {
    push(
      "call_permission_request",
      "A call-permission request needs body text explaining why you want to call.",
    );
  }
}

type Push = (field: string, message: string) => void;

function validateBody(comps: ValidatableComponent[], format: DetectedParameterFormat, push: Push) {
  const body = comps.find((c) => c.type === "BODY");
  const text = body?.text ?? "";
  if (text.length > TEMPLATE_LIMITS.bodyMaxLength) {
    push(
      "body",
      `Body is ${text.length} characters — the limit is ${TEMPLATE_LIMITS.bodyMaxLength}.`,
    );
  }
  if (!body) return;

  if (format === "named") {
    validateNamedExamples(
      "body",
      templateNamedPlaceholders(text),
      body.example?.body_text_named_params,
      push,
    );
    return;
  }

  const indices = positionalPlaceholderIndices(text);
  if (indices.length === 0) return;
  validateConsecutive("body", indices, push);

  // `example.body_text` is an array-of-arrays: one inner array per example set.
  const outer = Array.isArray(body.example?.body_text) ? body.example.body_text : null;
  const supplied = Array.isArray(outer?.[0]) ? (outer[0] as unknown[]) : null;
  const need = Math.max(...indices);
  if (!supplied) {
    push("body", `Body has ${need} variable(s) but no example values. Meta requires one per variable.`);
  } else if (supplied.length !== need) {
    push(
      "body",
      `Body has ${need} variable(s) but ${supplied.length} example value(s). They must match exactly.`,
    );
  }
}

function validateHeader(
  comps: ValidatableComponent[],
  format: DetectedParameterFormat,
  category: string | undefined,
  push: Push,
) {
  const header = comps.find((c) => c.type === "HEADER");
  if (!header) return;
  const fmt = (header.format ?? "TEXT").toUpperCase();

  if (fmt === "LOCATION") {
    if (category && !LOCATION_HEADER_CATEGORIES.includes(category as "utility" | "marketing")) {
      push(
        "header",
        `A location header is only allowed on ${LOCATION_HEADER_CATEGORIES.join(" or ")} templates.`,
      );
    }
    return;
  }

  if (fmt === "GIF") {
    // Meta's components doc: "Gifs are only available for Marketing Messages
    // API" — a different product from the Cloud API this platform sends
    // through. Kept in MEDIA_HEADER_FORMATS so a synced catalog row carrying
    // one still parses; refused at AUTHORING so an operator doesn't create a
    // template our send path can never deliver.
    push(
      "header",
      "GIF headers are a Marketing Messages API feature and can't be sent through " +
        "the WhatsApp Cloud API — use a VIDEO header instead (larger gifs display " +
        "as videos anyway).",
    );
    return;
  }

  if ((MEDIA_HEADER_FORMATS as readonly string[]).includes(fmt)) {
    const handle = exampleValues(header.example?.header_handle)[0];
    if (!handle) {
      push("header", `A ${fmt.toLowerCase()} header needs an uploaded media example.`);
    }
    return;
  }

  // TEXT header.
  const text = header.text ?? "";
  if (text.length > TEMPLATE_LIMITS.headerMaxLength) {
    push(
      "header",
      `Header is ${text.length} characters — the limit is ${TEMPLATE_LIMITS.headerMaxLength}.`,
    );
  }
  if (format === "named") {
    const names = templateNamedPlaceholders(text);
    if (names.length > 1) {
      push("header", "A header supports at most one variable.");
    }
    validateNamedExamples("header", names, header.example?.header_text_named_params, push);
    return;
  }
  const indices = positionalPlaceholderIndices(text);
  if (indices.length === 0) return;
  if (new Set(indices).size > 1) {
    push("header", "A header supports at most one variable.");
    return;
  }
  const supplied = exampleValues(header.example?.header_text);
  if (supplied.length !== 1) {
    push("header", "The header variable needs exactly one example value.");
  }
}

function validateFooter(comps: ValidatableComponent[], push: Push) {
  const footer = comps.find((c) => c.type === "FOOTER");
  if (!footer) return;
  const text = footer.text ?? "";
  if (text.length > TEMPLATE_LIMITS.footerMaxLength) {
    push(
      "footer",
      `Footer is ${text.length} characters — the limit is ${TEMPLATE_LIMITS.footerMaxLength}.`,
    );
  }
  // KEEP THIS despite Meta's utility-template page claiming "<FOOTER_TEXT> …
  // Variables are supported". Two things settle it against that line:
  //   1. The footer component has no `example` slot in ANY create payload, and
  //      Meta requires an example for every parameter;
  //   2. no SEND payload in any of Meta's docs has a `footer` component at all —
  //      the send components are header, body, button and
  //      tap_target_configuration. There is literally no channel to pass a
  //      footer value through.
  // A footer placeholder therefore can never be filled and ships to the customer
  // as literal `{{1}}`. (That same utility table also says button labels are
  // "alphanumeric characters only" while its own examples contain spaces, and
  // spells the document header type "documentation" — it is not a reliable
  // source on its own.)
  if (positionalPlaceholderIndices(text).length > 0 || templateNamedPlaceholders(text).length > 0) {
    push("footer", "Footers can't contain variables — there's no way to fill one in.");
  }
}

function validateButtons(comps: ValidatableComponent[], push: Push) {
  const buttons = comps.find((c) => c.type === "BUTTONS")?.buttons ?? [];
  if (buttons.length === 0) return;

  if (buttons.length > TEMPLATE_LIMITS.maxButtons) {
    push("buttons", `A template can have at most ${TEMPLATE_LIMITS.maxButtons} buttons.`);
  }

  const typeOf = (b: ValidatableButton) => (b.type ?? "").toUpperCase();
  const countOf = (t: string) => buttons.filter((b) => typeOf(b) === t).length;
  for (const [type, cap, label] of [
    ["QUICK_REPLY", TEMPLATE_LIMITS.maxQuickReplyButtons, "quick-reply"],
    ["URL", TEMPLATE_LIMITS.maxUrlButtons, "URL"],
    ["PHONE_NUMBER", TEMPLATE_LIMITS.maxPhoneNumberButtons, "phone-number"],
    ["COPY_CODE", TEMPLATE_LIMITS.maxCopyCodeButtons, "copy-code"],
  ] as const) {
    if (countOf(type) > cap) {
      push("buttons", `At most ${cap} ${label} button${cap === 1 ? "" : "s"}.`);
    }
  }

  // Quick replies must form ONE contiguous run. Meta groups buttons into
  // quick-reply and non-quick-reply blocks and rejects an interleaved order
  // ("Quick Reply, URL, Quick Reply") as an invalid combination.
  const quickReplyRuns = buttons
    .map((b) => typeOf(b) === "QUICK_REPLY")
    .reduce<number>((runs, isQr, i, all) => (isQr && !all[i - 1] ? runs + 1 : runs), 0);
  if (quickReplyRuns > 1) {
    push(
      "buttons",
      "Quick-reply buttons must be grouped together — put them all before or all after the other buttons.",
    );
  }

  for (const [i, b] of buttons.entries()) {
    const type = typeOf(b);
    const at = `Button ${i + 1}`;

    // COPY_CODE is the one type with no label; every other type has one.
    if (type !== "COPY_CODE" && (b.text?.length ?? 0) > TEMPLATE_LIMITS.buttonTextMaxLength) {
      push(
        "buttons",
        `${at} label is ${b.text!.length} characters — the limit is ${TEMPLATE_LIMITS.buttonTextMaxLength}.`,
      );
    }

    if (type === "URL") {
      const url = b.url ?? "";
      if (url.length > TEMPLATE_LIMITS.urlMaxLength) {
        push("buttons", `${at} URL is ${url.length} characters — the limit is ${TEMPLATE_LIMITS.urlMaxLength}.`);
      }
      const positional = positionalPlaceholderIndices(url);
      const named = templateNamedPlaceholders(url);
      const varCount = positional.length + named.length;
      if (varCount > 1) {
        push("buttons", `${at} URL supports at most one variable.`);
      }
      if (varCount === 1) {
        // Meta only substitutes a SUFFIX: the variable must close the string.
        // A mid-URL placeholder is accepted at creation and then produces a
        // broken link for every recipient.
        if (!/\{\{\s*[A-Za-z0-9_]+\s*\}\}\s*$/.test(url)) {
          push("buttons", `${at} URL variable must be at the very end of the URL.`);
        }
        if (exampleValues(b.example).length === 0) {
          push("buttons", `${at} URL has a variable, so it needs an example value.`);
        }
      }
    }

    if (type === "PHONE_NUMBER") {
      const phone = b.phone_number ?? "";
      if (phone.length === 0) {
        push("buttons", `${at} needs a phone number.`);
      } else if (phone.length > TEMPLATE_LIMITS.phoneNumberMaxLength) {
        push(
          "buttons",
          `${at} phone number is ${phone.length} characters — the limit is ${TEMPLATE_LIMITS.phoneNumberMaxLength}.`,
        );
      }
    }

    if (type === "COPY_CODE") {
      const code = exampleValues(b.example)[0] ?? "";
      if (code.length === 0) {
        push("buttons", `${at} (copy code) needs an example code.`);
      } else if (code.length > TEMPLATE_LIMITS.copyCodeExampleMaxLength) {
        push(
          "buttons",
          `${at} copy code is ${code.length} characters — the limit is ${TEMPLATE_LIMITS.copyCodeExampleMaxLength}.`,
        );
      }
    }
  }
}

/** Meta requires `{{1}}…{{N}}` with no gaps and no zero. */
/**
 * Percent-encode a dynamic URL-button suffix for the wire.
 *
 * Meta's components doc: unencoded special characters (spaces, `:`, `|`, `ç`,
 * `ñ`, …) in a URL parameter make the generated URL fail validation and the
 * send error. Already-encoded input passes through untouched — a value that
 * decodes cleanly AND re-encodes to itself is already in wire form, and
 * re-encoding it would turn %20 into %2520.
 *
 * Shared by the single-send path and the broadcast runner so a suffix that
 * works in the reply box can't fail in a campaign. NOT for authentication
 * codes: they ride the same `url` sub_type but go verbatim (Meta's own example
 * sends the code raw; encoding `J$FpnYnP` breaks autofill).
 */
export function encodeUrlButtonValue(value: string): string {
  try {
    const decoded = decodeURIComponent(value);
    if (encodeURIComponent(decoded) === value) return value;
  } catch {
    // Malformed percent sequence (e.g. a literal "100%") — encode the raw value.
  }
  return encodeURIComponent(value);
}

/**
 * Does this template need a commerce feature the platform can't supply?
 *
 * Catalog / MPM / SPM / order-details / product-card templates are legal on
 * Cloud API but their SENDS require product-catalog parameters (retailer ids,
 * section lists, payment configuration) that nothing in this platform collects
 * — so a synced one looks sendable in every picker, demands nothing in the
 * fill UI, and then fails EVERY send with an unlabelled Meta error. Naming the
 * refusal is strictly better; this is not a never-tighten violation because
 * the send as we would build it (no commerce component) always fails.
 *
 * FLOW buttons are deliberately NOT here: a flow send's parameters are
 * optional on the wire, so it may work without any — refusing it would block
 * sends Meta accepts.
 *
 * Returns a short human label for the missing feature, or null when fine.
 */
export function unsupportedTemplateFeature(components: unknown): string | null {
  if (!Array.isArray(components)) return null;
  const commerce: Record<string, string> = {
    CATALOG: "product catalog",
    MPM: "multi-product catalog",
    SPM: "product catalog",
    ORDER_DETAILS: "order details / payments",
    PRODUCT: "product catalog",
  };
  const scan = (comps: ReadonlyArray<unknown>): string | null => {
    for (const c of asComponents(comps)) {
      const type = (c.type ?? "").toUpperCase();
      if (commerce[type]) return commerce[type];
      for (const b of c.buttons ?? []) {
        const bt = (b.type ?? "").toUpperCase();
        if (commerce[bt]) return commerce[bt];
      }
      for (const card of c.cards ?? []) {
        const inner = scan(card.components ?? []);
        if (inner) return inner;
      }
    }
    return null;
  };
  return scan(components);
}

/**
 * ADVISORY review-risk patterns, deliberately a separate function from
 * `validateTemplateComponents`: these are Meta's documented "common rejection
 * reasons" from the human/ML REVIEW, not wire-validity rules — and Meta's own
 * presets break them (the authentication body "{{1}} is your verification
 * code." starts with a parameter), so blocking on them would refuse templates
 * Meta approves. The form renders these as warnings that never gate submit;
 * the API ignores them entirely.
 *
 * Covered, per the template-review doc:
 * - unbalanced `{{`/`}}` ("missing or mismatched curly braces");
 * - `{{…}}` tokens that are a variable in NEITHER dialect ("variable
 *   parameters contain special characters such as #, $, or %") — our
 *   detectors pass these through as literal prose, so without this the author
 *   learns of the typo only from a 24-hour review round-trip;
 * - a body that starts or ends with a variable ("dangling parameters").
 */
export function templateReviewWarnings(
  components: ReadonlyArray<unknown>,
): TemplateValidationIssue[] {
  const issues: TemplateValidationIssue[] = [];
  const push = (field: string, message: string) => issues.push({ field, message });

  const comps = asComponents(components);
  const surfaces: Array<[string, string]> = [];
  const body = comps.find((c) => c.type === "BODY");
  if (body?.text) surfaces.push(["body", body.text]);
  const header = comps.find((c) => c.type === "HEADER");
  if ((header?.format ?? "TEXT").toUpperCase() === "TEXT" && header?.text) {
    surfaces.push(["header", header.text]);
  }

  const token = /\{\{\s*(?:\d+|[A-Za-z_][A-Za-z0-9_]*)\s*\}\}/;
  for (const [field, text] of surfaces) {
    const open = (text.match(/\{\{/g) ?? []).length;
    const close = (text.match(/\}\}/g) ?? []).length;
    if (open !== close) {
      push(
        field,
        `Found ${open} "{{" but ${close} "}}" — a variable needs matching double braces, ` +
          `like {{1}} or {{order_id}}. Meta commonly rejects mismatched braces in review.`,
      );
    }
    for (const match of text.matchAll(/\{\{([^{}]*)\}\}/g)) {
      const raw = match[1] ?? "";
      const inner = raw.trim();
      if (/^\d+$/.test(inner) || /^[A-Za-z_][A-Za-z0-9_]*$/.test(inner)) continue;
      push(
        field,
        `"{{${raw}}}" isn't a variable in either format — it will be sent as literal text. ` +
          `If a variable was intended, use a number ({{1}}) or letters, digits and ` +
          `underscores ({{order_id}}); Meta rejects variables with special characters.`,
      );
    }
  }

  // Dangling check applies to the message BODY only — a text header is a
  // single short line where a lone variable (e.g. an order number) is a
  // normal, approvable shape.
  const bodyText = (body?.text ?? "").trim();
  if (bodyText) {
    const startsWith = new RegExp(`^${token.source}`).test(bodyText);
    const endsWith = new RegExp(`${token.source}$`).test(bodyText);
    if (startsWith || endsWith) {
      push(
        "body",
        `The body ${
          startsWith && endsWith ? "starts and ends" : startsWith ? "starts" : "ends"
        } with a variable — Meta's review commonly rejects dangling parameters. ` +
          `Consider adding text around it.`,
      );
    }
  }

  return issues;
}

function validateConsecutive(field: string, indices: number[], push: Push) {
  const seen = new Set(indices);
  const max = Math.max(...indices);
  const missing: number[] = [];
  for (let i = 1; i <= max; i += 1) if (!seen.has(i)) missing.push(i);
  if (seen.has(0)) {
    push(field, "Variables are numbered from {{1}} — {{0}} isn't valid.");
  }
  if (missing.length > 0) {
    push(
      field,
      `Variables must run {{1}} to {{${max}}} with no gaps — missing ${missing
        .map((n) => `{{${n}}}`)
        .join(", ")}.`,
    );
  }
}

/** Every named placeholder needs a `{ param_name, example }` entry. */
function validateNamedExamples(
  field: string,
  names: string[],
  raw: unknown,
  push: Push,
) {
  if (names.length === 0) return;
  const params = Array.isArray(raw)
    ? (raw as Array<{ param_name?: unknown; example?: unknown }>)
    : [];
  const supplied = new Map(
    params
      .filter((p) => typeof p.param_name === "string")
      .map((p) => [p.param_name as string, typeof p.example === "string" ? p.example : ""]),
  );
  const missing = names.filter((n) => !(supplied.get(n) ?? "").trim());
  if (missing.length > 0) {
    push(
      field,
      `Missing example value(s) for ${missing.map((n) => `{{${n}}}`).join(", ")}. ` +
        "Meta requires an example for every named variable.",
    );
  }
}

// ---------------------------------------------------------------------------
// Template Library parameter types.
// ---------------------------------------------------------------------------

/**
 * Check a value against the parameter type a Template Library blueprint
 * declares for that position.
 *
 * Meta enforces these AT SEND TIME: a value outside the type's accepted range
 * fails that individual message, with an error that names neither the parameter
 * nor the reason. Checking first turns "message failed" into "that isn't a valid
 * email address".
 *
 * DELIBERATELY PERMISSIVE. Only the types Meta describes unambiguously are
 * checked; `ADDRESS`, `TEXT` and `DATE` are not, because Meta accepts a wide and
 * under-specified range for each (`5th January 1982`, `08.22.1991` and
 * `05 12 2022` are all valid dates) and a validator stricter than the provider
 * blocks sends that would have succeeded — indistinguishable from a bug.
 *
 * Returns null when the value is acceptable, else a human-readable reason.
 */
export function validateTemplateParamValue(
  type: string,
  value: string,
): string | null {
  const v = value.trim();
  if (v.length === 0) return "is required";

  switch (type.toUpperCase().replace(/\s+/g, "_")) {
    case "EMAIL":
      // Deliberately loose — the point is to catch "not an email at all", not to
      // relitigate RFC 5322.
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? null : "must be a valid email address";
    case "PHONE_NUMBER":
      // Meta: "may contain numbers, spaces, dashes (-), parentheses, and plus".
      return /^[\d\s\-()+]+$/.test(v) && /\d/.test(v)
        ? null
        : "must be a phone number (digits, spaces, dashes, parentheses, +)";
    case "NUMBER":
      // Meta: "must be a number. Cannot contain spaces."
      return /^\d+$/.test(v) ? null : "must be a number with no spaces";
    case "AMOUNT":
      // Meta allows currency prefixes/suffixes, symbols, commas and decimals —
      // so the only firm rule is that there is a quantity in there somewhere.
      return /\d/.test(v) ? null : "must contain an amount";
    default:
      return null;
  }
}

/**
 * Validate a full set of body values against a library template's declared
 * parameter types. Positional: `types[i]` describes `values[i]`.
 *
 * Reports every bad value rather than the first, so one correction pass fixes
 * the whole form.
 */
export function validateTemplateParamValues(
  types: ReadonlyArray<string>,
  values: ReadonlyArray<string>,
): TemplateValidationIssue[] {
  const issues: TemplateValidationIssue[] = [];
  types.forEach((type, i) => {
    const value = values[i];
    if (value === undefined) return;
    const problem = validateTemplateParamValue(type, value);
    if (problem) {
      issues.push({
        field: `body.${i}`,
        message: `Value ${i + 1} (${type.toLowerCase().replace(/_/g, " ")}) ${problem}.`,
      });
    }
  });
  return issues;
}

// ---------------------------------------------------------------------------
// Archival.
// ---------------------------------------------------------------------------

/**
 * Meta deletes an archived template this many days after archiving it. Until
 * then it can be unarchived (in WhatsApp Manager), which restores its previous
 * status and cancels the deletion.
 */
export const TEMPLATE_ARCHIVE_DELETION_DAYS = 28;

/** Inactivity after which Meta auto-archives. Not opt-out-able. */
export const TEMPLATE_AUTO_ARCHIVE_MONTHS = 12;

/**
 * Days left before Meta permanently deletes an archived template.
 *
 * `archivedAt` is when we OBSERVED the archival — exact if the status webhook
 * delivered it, approximate if a sync found the template already archived — so
 * callers must present this as "about N days", never as a precise deadline.
 * Returns 0 once the window has elapsed (deletion is imminent or already done;
 * the next catalog sync prunes the row).
 */
export function templateDeletionDaysLeft(archivedAt: Date | string | null): number | null {
  if (!archivedAt) return null;
  const at = typeof archivedAt === "string" ? new Date(archivedAt) : archivedAt;
  if (Number.isNaN(at.getTime())) return null;
  const deadline = at.getTime() + TEMPLATE_ARCHIVE_DELETION_DAYS * 86_400_000;
  return Math.max(0, Math.ceil((deadline - Date.now()) / 86_400_000));
}

/**
 * Whether a template is close enough to Meta's 12-month inactivity cutoff to be
 * worth warning about.
 *
 * The point is to act BEFORE archival: once archived there are 28 days and a
 * manual trip to WhatsApp Manager, whereas sending the template even once now
 * resets the clock entirely. `null` (never used, and no creation date to fall
 * back on) is not a warning — it is simply unknown.
 */
export function templateArchivalRisk(
  lastActivityAt: Date | string | null,
  warnWithinDays = 30,
): { atRisk: boolean; daysLeft: number } | null {
  if (!lastActivityAt) return null;
  const at =
    typeof lastActivityAt === "string" ? new Date(lastActivityAt) : lastActivityAt;
  if (Number.isNaN(at.getTime())) return null;
  // 12 months as 365 days — Meta doesn't publish the exact calendar rule, and a
  // day either way only shifts a warning, never a decision.
  const cutoff = at.getTime() + TEMPLATE_AUTO_ARCHIVE_MONTHS * 30.44 * 86_400_000;
  const daysLeft = Math.ceil((cutoff - Date.now()) / 86_400_000);
  return { atRisk: daysLeft <= warnWithinDays, daysLeft };
}

// ---------------------------------------------------------------------------
// Time-to-live.
// ---------------------------------------------------------------------------

/**
 * How long Meta retries delivery before dropping a message, per category.
 *
 * These are Meta's published numbers, not ours. The ranges differ per category
 * and they do NOT overlap at the low end — a utility template's 12-hour maximum
 * is exactly the marketing minimum — which is why a TTL can only be judged
 * against the category it belongs to.
 *
 * `defaultSeconds` is what Meta applies when no TTL is set. We never write it to
 * a row: it is Meta's to change, and materializing it would turn "unset" into a
 * value the operator never chose.
 */
export const TEMPLATE_TTL_RULES = {
  authentication: { min: 30, max: 900, defaultSeconds: 600 },
  utility: { min: 30, max: 43_200, defaultSeconds: 2_592_000 },
  // KEEP marketing here despite the MM-API "Features" comparison table claiming
  // Cloud API TTL "only supports Authentication and Utility" — the dedicated
  // Cloud API TTL reference documents this exact marketing range (12h–30d),
  // and a comparison table selling a different product is not the authority on
  // this one. (Same reliability class as the utility page's footer-variables
  // claim.)
  marketing: { min: 43_200, max: 2_592_000, defaultSeconds: 2_592_000 },
} as const;

/**
 * Meta's sentinel for "30 days", accepted on authentication and utility
 * templates only.
 *
 * It exists because 30 days is far outside both of those categories' normal
 * ranges (15 minutes and 12 hours), so there is no in-range number that can
 * express it. Rejecting it as "not a positive integer" — which a naive guard
 * does — blocks a documented, useful value.
 */
export const TEMPLATE_TTL_THIRTY_DAYS = -1;

/** Categories on which `-1` is accepted. */
const TTL_SENTINEL_CATEGORIES = ["authentication", "utility"] as const;

/** Seconds → "30 days" / "12 hours" / "15 minutes" / "45 seconds". */
export function formatTtlSeconds(seconds: number): string {
  if (seconds === TEMPLATE_TTL_THIRTY_DAYS) return "30 days";
  const units: Array<[number, string]> = [
    [86_400, "day"],
    [3_600, "hour"],
    [60, "minute"],
  ];
  for (const [size, label] of units) {
    if (seconds % size === 0 && seconds >= size) {
      const n = seconds / size;
      return `${n} ${label}${n === 1 ? "" : "s"}`;
    }
  }
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

/**
 * Check a TTL against the category's range.
 *
 * Returns null when acceptable, else a message naming the actual range — Meta
 * rejects an out-of-range value with an opaque `#100` that names neither the
 * field nor the bound, which is the whole reason this is checked first.
 */
export function validateTemplateTtl(
  category: string,
  seconds: number,
): string | null {
  const rules = TEMPLATE_TTL_RULES[category as keyof typeof TEMPLATE_TTL_RULES];
  if (!rules) return null; // Unknown category — not ours to adjudicate.

  if (seconds === TEMPLATE_TTL_THIRTY_DAYS) {
    return (TTL_SENTINEL_CATEGORIES as readonly string[]).includes(category)
      ? null
      : `-1 (30 days) is only accepted on authentication and utility templates. ` +
          `For ${category}, use a value in seconds.`;
  }
  if (!Number.isInteger(seconds) || seconds < rules.min || seconds > rules.max) {
    return (
      `Time-to-live for a ${category} template must be between ` +
      `${formatTtlSeconds(rules.min)} and ${formatTtlSeconds(rules.max)} ` +
      `(${rules.min}–${rules.max} seconds)` +
      ((TTL_SENTINEL_CATEGORIES as readonly string[]).includes(category)
        ? ", or -1 for 30 days."
        : ".")
    );
  }
  return null;
}
