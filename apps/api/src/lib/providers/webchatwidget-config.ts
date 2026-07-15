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
 *   - `getWebchatwidgetSendConfig(teamId)` — the registry's send-config loader.
 *     Its only job is to gate sends: it throws `ProviderNotConfiguredError` when
 *     the team has NO active widget, so the outbound preflight returns
 *     `channel_not_connected`. Sends do no vendor I/O (delivery is realtime).
 *   - `resolveWebchatwidgetByPublicKey(publicKey)` — the PUBLIC entry point used
 *     by the visitor gateway + the public config/media endpoints to resolve which
 *     team + widget a site key belongs to. Backed by the unique index on
 *     `WebchatWidget.publicKey` (one lookup), cached against visitor storms.
 */

/** A profile field the pre-chat form can collect (self-asserted). */
export interface WebchatwidgetPreChatField {
  /** Stable id (cuid) so responses map back to the field. */
  id: string;
  label: string;
  /** Drives the input type + identity handling (email/phone → strong key). */
  type: "text" | "name" | "email" | "phone";
  required: boolean;
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
  // ---- launcher / placement defaults (used by the settings UI to generate the
  //      embed snippet; the widget itself reads these from data-* attributes) ----
  launcher?: "bubble" | "off";
  position?: "right" | "left";
  launcherLabel?: string;
}

/** Send-side config. Empty — the provider does no vendor I/O. */
export type WebchatwidgetSendConfig = Record<string, never>;

/** What a resolved site key yields to the public surfaces (never secrets). */
export interface WebchatwidgetResolved {
  teamId: string;
  widgetId: string;
  name: string;
  allowedOrigins: string[];
  config: WebchatwidgetConfig;
}

const connectedCache = new TtlCache<boolean>();
const byKeyCache = new TtlCache<WebchatwidgetResolved | null>();

/** Drop the "is this team connected?" cache. Call after a widget CRUD change. */
export function invalidateWebchatwidgetTeam(teamId: string): void {
  connectedCache.delete(teamId);
}

/** Drop a resolved-by-key cache entry. Call after editing/deleting that widget. */
export function invalidateWebchatwidgetKey(publicKey: string): void {
  byKeyCache.delete(publicKey);
}

/**
 * Send-side config. Throws ProviderNotConfigured when the team has no active
 * widget, so the outbound preflight fails fast with `channel_not_connected` —
 * same contract as the Meta loaders. Returns an empty config on success (the
 * provider ignores it; delivery is realtime).
 */
export async function getWebchatwidgetSendConfig(
  teamId: string,
): Promise<WebchatwidgetSendConfig> {
  const cached = connectedCache.get(teamId);
  const connected =
    cached !== undefined
      ? cached
      : await (async () => {
          const count = await db.webchatWidget.count({
            where: { teamId, isActive: true },
          });
          const ok = count > 0;
          connectedCache.set(teamId, ok);
          return ok;
        })();
  if (!connected) throw new ProviderNotConfiguredError(teamId, ["no-active-widget"], "webchatwidget");
  return {};
}

/**
 * Resolve the team + widget for a public site key. Returns null for an
 * unknown/inactive key. Used by the visitor gateway handshake and the public
 * config/media endpoints — the site key is the anonymous entry point, so this is
 * cached to keep visitor traffic off Postgres. Backed by the unique index on
 * `WebchatWidget.publicKey`.
 */
export async function resolveWebchatwidgetByPublicKey(
  publicKey: string,
): Promise<WebchatwidgetResolved | null> {
  if (!publicKey) return null;
  const cached = byKeyCache.get(publicKey);
  if (cached !== undefined) return cached;
  const widget = await db.webchatWidget.findUnique({
    where: { publicKey },
    select: { id: true, teamId: true, name: true, allowedOrigins: true, config: true, isActive: true },
  });
  const resolved: WebchatwidgetResolved | null =
    widget && widget.isActive
      ? {
          teamId: widget.teamId,
          widgetId: widget.id,
          name: widget.name,
          allowedOrigins: widget.allowedOrigins,
          config: (widget.config ?? {}) as WebchatwidgetConfig,
        }
      : null;
  byKeyCache.set(publicKey, resolved);
  return resolved;
}
