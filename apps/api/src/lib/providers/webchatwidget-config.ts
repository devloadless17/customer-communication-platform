import { loadSelectFieldCatalog } from "@/lib/contact-fields/select-values";
import { db } from "@/lib/db";
import { ProviderNotConfiguredError } from "@/lib/providers/config";
import { TtlCache } from "@/lib/providers/config-cache";

/**
 * Website chat-widget config. This is a FIRST-PARTY channel with no external
 * vendor and, unlike the Meta channels, a team runs MANY named widgets (one per
 * website) — so widgets live in their own `WebchatWidget` rows, NOT a
 * ChannelConnection. There is no secret to send with: a widget's public site key
 * is safe-in-HTML and abuse is bounded by its allowed-origins list + rate limits.
 *
 * Two read paths:
 *   - `getWebchatwidgetSendConfig(workspaceId)` — the registry's send-config loader.
 *     Its only job is to gate sends: it throws `ProviderNotConfiguredError` when
 *     the team has NO active widget, so the outbound preflight returns
 *     `channel_not_connected`. Sends do no vendor I/O (delivery is realtime).
 *   - `resolveWebchatwidgetByPublicKey(publicKey)` — the PUBLIC entry point used
 *     by the visitor gateway + the public config/media endpoints to resolve which
 *     team + widget a site key belongs to. Backed by the unique index on
 *     `WebchatWidget.publicKey` (one lookup), cached against visitor storms.
 */

/**
 * Attachment kinds an organization can allow or forbid on their widget. Mirrors the
 * `MediaKind`s the channel supports (`media-caps.ts`) minus `sticker`, which the
 * widget never sends.
 */
export const WEBCHATWIDGET_MEDIA_KINDS = ["image", "video", "audio", "document"] as const;
export type WebchatwidgetMediaKind = (typeof WEBCHATWIDGET_MEDIA_KINDS)[number];

/**
 * Is `kind` allowed on this widget? Absent config = everything allowed, so existing
 * widgets keep working untouched.
 */
export function widgetAllowsMediaKind(
  config: WebchatwidgetConfig | undefined,
  kind: string,
): boolean {
  const allowed = config?.allowedMediaKinds;
  if (!Array.isArray(allowed)) return true;
  // `sticker` is a legacy classification of an image (see classifyWebpAsImage) —
  // gate it with images so an old row can't sneak past an images-off policy.
  const effective = kind === "sticker" ? "image" : kind;
  return allowed.includes(effective as WebchatwidgetMediaKind);
}

/** A profile field the pre-chat form can collect (self-asserted). */
export interface WebchatwidgetPreChatField {
  /** Stable id (cuid) so responses map back to the field. */
  id: string;
  label: string;
  /** Drives the input type + identity handling (email/phone → strong key). */
  type: "text" | "name" | "email" | "phone";
  required: boolean;
  /**
   * `ContactFieldDefinition.key` this question writes to — `text` questions only.
   * The label is the question the visitor reads; this is where the answer lands,
   * and the two are deliberately independent so rewording a question can't
   * silently start a second field. Absent on legacy rows configured before the
   * picker existed, which still fall back to a slug of the label (webchat-prechat.ts).
   */
  key?: string;
  /**
   * Options, when `key` names a SELECT field. Not persisted in the widget's config
   * — attached at resolve time from the live definition, so renaming or reordering
   * options can't leave a stale copy on the visitor's form. The widget renders a
   * dropdown and submits an option ID.
   */
  options?: { id: string; name: string }[];
}

/** Appearance overrides; each blank falls back to a platform default. */
export interface WebchatwidgetTheme {
  /** Header + send button + assistant accent. */
  primaryColor?: string;
  /** Launcher bubble. */
  launcherColor?: string;
  /** The visitor's own message bubble. */
  userBubbleColor?: string;
}

/** Non-secret per-widget config, stored in `WebchatWidget.config`. */
export interface WebchatwidgetConfig {
  theme?: WebchatwidgetTheme;
  welcomeMessage?: string;
  headerTitle?: string;
  /** Line under the title, e.g. "Typically replies in a few minutes". */
  headerSubtitle?: string;
  suggestedQuestions?: string[];
  preChatFields?: WebchatwidgetPreChatField[];
  showBranding?: boolean;
  // ---- full theming (delivered to the widget on `ready`) ----
  /** Header logo — a small size-capped data: URI (no external host). */
  logoDataUrl?: string;
  /** Default agent avatar shown on inbound bubbles — a size-capped data: URI. */
  agentAvatarDataUrl?: string;
  fontFamily?: "system" | "rounded" | "serif";
  themeMode?: "light" | "dark" | "auto";
  /** Play a subtle chime in the widget when an agent replies (visitor opt-in). */
  soundEnabled?: boolean;
  /**
   * Which attachment kinds a VISITOR may send, e.g. `["image","document"]`.
   *
   * Absent = all kinds (the default, and what every existing widget gets).
   * `[]` = a text-only chat: the attach and mic buttons disappear entirely.
   *
   * This is a real control, not a UI hint — it is enforced server-side on the
   * upload endpoint, because the widget runs on someone else's page and nothing
   * it does can be trusted. Hiding the button is only the courtesy half.
   */
  allowedMediaKinds?: WebchatwidgetMediaKind[];
  /** Shown when no agent is online. */
  awayMessage?: string;
  /**
   * Per-widget AI-autopilot switch. Absent/false = OFF (default): the assistant
   * never auto-answers this widget's conversations even when the team has AI
   * configured. Gated in ai-reply.subscriber.ts via `webchatwidgetAiAllowed`.
   */
  aiEnabled?: boolean;
  /**
   * Hide the chat header on an EMBEDDED (inline / full-page) widget — a "just chat"
   * surface where the host page already provides the title/branding. Ignored for a
   * floating bubble (it needs the header's close/expand controls). Default: shown.
   */
  showHeader?: boolean;
  /**
   * Show the replying agent's name to the visitor. Default: shown (`!== false`).
   * When off the name is suppressed SERVER-SIDE — it never reaches the wire — so
   * agents stay anonymous to visitors. AI replies keep their "AI Assistant" label
   * either way (bot disclosure, not an agent identity).
   */
  showAgentName?: boolean;
  /**
   * Dial code (digits only, e.g. "961") prefilled in the pre-chat PHONE field so
   * visitors don't drop their country code. Absent → the widget's built-in default.
   */
  phoneDialCode?: string;
  // ---- launcher / placement defaults (used by the settings UI to generate the
  //      embed snippet; the widget itself reads these from data-* attributes) ----
  /**
   * Deploy mode, one per page (the widget is a singleton):
   * `bubble` floating launcher · `off` opened from the host's own button ·
   * `inline` embedded in a container on their page. Settings uses this to show
   * the ONE matching install snippet.
   */
  launcher?: "bubble" | "off" | "inline";
  position?: "right" | "left";
  launcherLabel?: string;
}

/** Send-side config. Empty — the provider does no vendor I/O. */
export type WebchatwidgetSendConfig = Record<string, never>;

/** What a resolved site key yields to the public surfaces (never secrets). */
export interface WebchatwidgetResolved {
  workspaceId: string;
  widgetId: string;
  name: string;
  allowedOrigins: string[];
  config: WebchatwidgetConfig;
  /** Already-observed embed host, or null. Cached so the hot path skips a write. */
  firstSeenOrigin: string | null;
}

const connectedCache = new TtlCache<boolean>();
const byKeyCache = new TtlCache<WebchatwidgetResolved | null>();

/** Drop the "is this team connected?" cache. Call after a widget CRUD change. */
export function invalidateWebchatwidgetTeam(workspaceId: string): void {
  connectedCache.delete(workspaceId);
}

/** Drop a resolved-by-key cache entry. Call after editing/deleting that widget. */
export function invalidateWebchatwidgetKey(publicKey: string): void {
  byKeyCache.delete(publicKey);
}

/**
 * Drop the agent-name gate cache. Called on every widget save because the cache
 * is keyed by CONVERSATION while the setting lives on the WIDGET — there is no
 * targeted key to delete. Clearing all of it is cheap (one indexed lookup to
 * refill, only on webchat conversations) and it is the difference between an
 * admin hiding agent names and that taking effect NOW rather than within 60s,
 * which for a privacy control is the whole point.
 */
export function invalidateWebchatwidgetShowsAgentName(): void {
  showNameCache.clear();
}

/**
 * Send-side config. Throws ProviderNotConfigured when the team has no active
 * widget, so the outbound preflight fails fast with `channel_not_connected` —
 * same contract as the Meta loaders. Returns an empty config on success (the
 * provider ignores it; delivery is realtime).
 */
export async function getWebchatwidgetSendConfig(
  workspaceId: string,
): Promise<WebchatwidgetSendConfig> {
  const cached = connectedCache.get(workspaceId);
  const connected =
    cached !== undefined
      ? cached
      : await (async () => {
          const count = await db.webchatWidget.count({
            where: { workspaceId, isActive: true },
          });
          const ok = count > 0;
          connectedCache.set(workspaceId, ok);
          return ok;
        })();
  if (!connected) throw new ProviderNotConfiguredError(workspaceId, ["no-active-widget"], "webchatwidget");
  return {};
}

/**
 * Resolve the team + widget for a public site key. Returns null for an
 * unknown/inactive key. Used by the visitor gateway handshake and the public
 * config/media endpoints — the site key is the anonymous entry point, so this is
 * cached to keep visitor traffic off Postgres. Backed by the unique index on
 * `WebchatWidget.publicKey`.
 */
/** `wc_pk_` + 48 hex = 54. The cap is generous headroom, not the format. */
const MAX_PUBLIC_KEY_LENGTH = 128;

export async function resolveWebchatwidgetByPublicKey(
  publicKey: string,
): Promise<WebchatwidgetResolved | null> {
  // Refused BEFORE the cache: the key is attacker-chosen and a miss is
  // negative-cached, so an over-long key would be stored verbatim as a cache
  // KEY. The entry count is bounded, the bytes were not.
  if (!publicKey || publicKey.length > MAX_PUBLIC_KEY_LENGTH) return null;
  const cached = byKeyCache.get(publicKey);
  if (cached !== undefined) return cached;
  const widget = await db.webchatWidget.findUnique({
    where: { publicKey },
    select: { id: true, workspaceId: true, name: true, allowedOrigins: true, config: true, isActive: true, firstSeenOrigin: true },
  });
  const resolved: WebchatwidgetResolved | null =
    widget && widget.isActive
      ? {
          workspaceId: widget.workspaceId,
          widgetId: widget.id,
          name: widget.name,
          allowedOrigins: widget.allowedOrigins,
          config: await withSelectOptions(widget.workspaceId, (widget.config ?? {}) as WebchatwidgetConfig),
          firstSeenOrigin: widget.firstSeenOrigin,
        }
      : null;
  byKeyCache.set(publicKey, resolved);
  return resolved;
}

/**
 * Attach live option lists to any pre-chat question bound to a SELECT contact
 * field, so the widget can render a dropdown instead of a free-text box.
 *
 * Read here rather than stored in the widget's config because options are edited
 * elsewhere (Settings → Contact fields): a persisted copy would go stale, and a
 * visitor picking a renamed option would submit a value that resolves to nothing.
 * One indexed query, and only for widgets that actually bind a select field —
 * inside the cached resolve, so at most once per TTL per widget.
 */
async function withSelectOptions(
  workspaceId: string,
  config: WebchatwidgetConfig,
): Promise<WebchatwidgetConfig> {
  const fields = config.preChatFields;
  if (!Array.isArray(fields) || fields.length === 0) return config;
  const keys = fields.filter((f) => f.type === "text" && f.key).map((f) => f.key!);
  if (keys.length === 0) return config;
  const catalog = await loadSelectFieldCatalog(workspaceId, keys);
  if (catalog.size === 0) return config;
  return {
    ...config,
    preChatFields: fields
      // A select field with an empty option list has nothing a visitor could
      // validly answer: the widget falls back to a text box and the server then
      // fails to resolve whatever they typed, discarding it silently. Dropping
      // the question is honest — better not to ask than to bin the answer.
      .filter((f) => !(f.key && catalog.get(f.key)?.options.length === 0))
      .map((f) => {
        const entry = f.key ? catalog.get(f.key) : undefined;
        return entry ? { ...f, options: entry.options } : f;
      }),
  };
}

/**
 * Is AI-autopilot allowed to answer THIS conversation?
 *
 * The AI reply subscriber calls this before enqueuing. For a conversation that is
 * NOT a widget one (`webchatWidgetId` null) it returns `true` — this gate only
 * governs the website widget; every other channel is unaffected. For a widget
 * conversation the answer is the widget's per-widget switch, which DEFAULTS OFF:
 * AI runs only when an admin explicitly set `config.aiEnabled = true` on an active
 * widget. A deleted/deactivated source widget (the `SetNull` relation leaves the
 * id but the row inactive/gone) is treated as OFF.
 *
 * One indexed lookup, and only reached on the AI path (team already has AI
 * configured), so it never touches the general inbound hot path.
 */
export async function webchatwidgetAiAllowed(
  workspaceId: string,
  conversationId: string,
): Promise<boolean> {
  const conv = await db.conversation.findFirst({
    where: { id: conversationId, workspaceId },
    select: {
      webchatWidgetId: true,
      webchatWidget: { select: { isActive: true, config: true } },
    },
  });
  // Not a widget conversation → this gate doesn't apply.
  if (!conv?.webchatWidgetId) return true;
  const w = conv.webchatWidget;
  if (!w || !w.isActive) return false;
  const cfg = (w.config ?? {}) as WebchatwidgetConfig;
  return cfg.aiEnabled === true;
}

/**
 * Should THIS conversation's visitor frames carry the replying agent's name?
 *
 * Mirrors `webchatwidgetAiAllowed` but with the OPPOSITE default: showing the name
 * is the long-standing behavior, so this fails OPEN — `true` for a non-widget
 * conversation, a missing source widget, an absent key, or a DB error. Only an
 * explicit `config.showAgentName === false` suppresses the name.
 *
 * Cached (60s TTL) and fail-soft because it sits on the REALTIME delivery tier:
 * the delivery service deliberately keeps that path off per-message DB reads
 * (see its nameCache note), and an uncaught throw there would drop the whole
 * message frame — the visitor wouldn't see the agent's reply until reconnect.
 */
const showNameCache = new TtlCache<boolean>();

export async function webchatwidgetShowsAgentName(
  workspaceId: string,
  conversationId: string,
): Promise<boolean> {
  // Cache key carries the workspace, like every other workspace-scoped cache
  // here — a conversation id alone would key one tenant's answer under a
  // lookup another tenant can perform.
  const cacheKey = `${workspaceId}:${conversationId}`;
  const hit = showNameCache.get(cacheKey);
  if (hit !== undefined) return hit;
  try {
    const conv = await db.conversation.findFirst({
      where: { id: conversationId, workspaceId },
      select: {
        webchatWidgetId: true,
        webchatWidget: { select: { config: true } },
      },
    });
    const cfg = (conv?.webchatWidget?.config ?? {}) as WebchatwidgetConfig;
    const show = cfg.showAgentName !== false;
    showNameCache.set(cacheKey, show);
    return show;
  } catch {
    return true;
  }
}

/**
 * Remember the first real domain that embeds a widget (trust-on-first-use).
 *
 * A new widget ships with an EMPTY allow-list, which is permissive — it has to be,
 * or it would refuse the customer's very first page load. But the site key is
 * public (it sits in the page source), so an unlocked widget can be lifted onto a
 * phishing page that impersonates the brand. Rather than demand a domain during
 * onboarding — data we don't collect, and a step that blocks first-run — we
 * observe the domain the widget is actually used on and let Settings offer a
 * one-click lock at the point the value is self-evidently right.
 *
 * Deliberately inert: this only ever RECORDS. It never rejects a connection, so a
 * wrong guess can't lock a customer out of their own widget.
 *
 * Cheap on the hot path — skipped entirely once the widget is locked or the origin
 * is already known (both read from the cached resolve). The write is a CAS
 * (`firstSeenOrigin: null`), so concurrent handshakes race harmlessly and the
 * FIRST one wins.
 */
export async function recordFirstSeenOrigin(
  publicKey: string,
  resolved: WebchatwidgetResolved,
  origin: string | null,
): Promise<void> {
  // Already locked down, or already observed → nothing to learn.
  if (resolved.allowedOrigins.length > 0 || resolved.firstSeenOrigin || !origin) return;
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return;
  }
  // Loopback is the developer testing their own embed, not the site to lock to.
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") return;
  const written = await db.webchatWidget.updateMany({
    where: { id: resolved.widgetId, firstSeenOrigin: null },
    data: { firstSeenOrigin: host },
  });
  // Refresh the cache so the next handshake short-circuits above instead of
  // re-running this no-op UPDATE for the rest of the TTL.
  if (written.count > 0) invalidateWebchatwidgetKey(publicKey);
}
