# Website chat widget (`webchatwidget`)

A first-party, embeddable live-chat widget. An org drops a `<script>` tag on any
website; visitor messages land in the shared inbox and agents/automation reply
back to the visitor live. Unlike WhatsApp/Messenger/Instagram there is **no
external vendor** — the platform is both ends of the wire.

## Multiple named widgets

A team runs **many** widgets (one per website), each a `WebchatWidget` row with
its own public **site key**, origin allow-list, name, and appearance. Every
`webchatwidget` conversation is stamped with its source widget
(`Conversation.webchatWidgetId`) so the inbox shows *which website* a chat came
from. Managed at **Settings → Website chat** (`team/webchatwidget/` admin API,
`@RequireRole("admin")`). The channel is "connected" for a team iff it has ≥1
active widget (`getWebchatwidgetSendConfig` gates on that).

## Embed & deploy modes

```html
<script src="https://YOUR-APP/widget.js" data-webchat-key="wc_pk_..." defer></script>
```

`apps/web/public/widget.js` is a hand-written classic script (Shadow DOM, isolated
from the host page) that loads socket.io's UMD client from the same origin
(`/webchat/socket.io.min.js`) and connects. Test page:
`/webchat/test.html`.

Deployment is flexible via `data-webchat-*` attributes (read at load, before the
socket `ready`), so it isn't only a floating bubble:

- `data-webchat-launcher="on|off"` (default `on`). `off` hides the bubble — open
  only via the JS API.
- `data-webchat-position="right|left"` (default `right`).
- `data-webchat-label="Chat with us"` — a text pill beside the bubble.
- `data-webchat-target="#selector"` — **inline embed**: the panel mounts INSIDE
  that element (fills the container, always open, no launcher). The container's
  size is the customer's to choose; a `min-height` floor stops a height-less
  ancestor chain collapsing it to nothing. If the element doesn't exist yet (a
  React/Next/Vue host that mounts after hydration) the widget watches for it for
  15s, then logs how to mount manually — a one-shot lookup used to leave SPA
  embeds permanently invisible.
- `data-webchat-api="https://api-host"` — override the API origin. Only needed
  when the API is NOT on the script's own origin, i.e. split-port local dev
  (`pnpm dev`: web :3000, api :4000). Production is single-origin behind Caddy.

**JS API:** `window.CCPWebchat = { open, close, toggle, isOpen, mount, unreadCount,
on }` with a pre-load call queue, so any element opens the chat — e.g.
`<a onclick="CCPWebchat.open()">Chat</a>` with the launcher hidden. This is the
"a link opens the chat" deployment.
- `mount(elOrSelector)` — attach an inline embed once its container exists (SPAs).
- `on(event, fn) → unsubscribe` for `"ready" | "message" | "unread" | "typing"`,
  so a host page can render its OWN unread badge or typing hint without reaching
  into the shadow root.

The panel **restores whatever state it was left in** — open stays open across a
refresh (`ccp_wc_open_<siteKey>`), conversation history replays on connect, and an
**unread badge** on the launcher signals agent replies received while it was closed.

## Allowed origins (and how a widget gets locked)

`WebchatWidget.allowedOrigins` holds hosts (`example.com`, `*.example.com`), and an
**EMPTY list is permissive on purpose** — a brand-new widget has to work on the
customer's page before they've configured anything, and refusing until a domain is
set would break every first install. `localhost`/`127.0.0.1` always pass in dev.

The residual risk is not spam, it's **impersonation**: the site key is public by
design (it sits in the page source of every page it's installed on), so an unlocked
widget can be lifted onto a phishing page where the visitor believes they're talking
to the brand and the agent sees an ordinary conversation.

**Trust-on-first-use** closes that without an onboarding step. The handshake records
`WebchatWidget.firstSeenOrigin` — the host of the first NON-loopback page to embed the
widget — and Settings then offers a one-click "Lock to `<domain>`". Properties:

- **Write-once** (`updateMany` CAS on `firstSeenOrigin: null`), so a later attacker
  origin cannot overwrite the suggestion to launder its own domain in.
- **Loopback is skipped** — a developer testing locally is not the site to lock to.
- **Only recorded while `allowedOrigins` is empty**, and it NEVER gates a connection
  on its own, so a wrong guess can't lock a customer out of their own widget.
- **Off the hot path**: fire-and-forget, and skipped entirely once the widget is
  locked or the origin is already known (both read from the cached resolve).

`recordFirstSeenOrigin` lives in `apps/api/src/lib/providers/webchatwidget-config.ts`
(domain layer) — the gateway only calls it.

## Theming

Appearance is per-widget `config` (delivered on `ready`): colors (primary /
launcher / user bubble), header title + subtitle, welcome message, suggested
questions, `logoDataUrl` + `agentAvatarDataUrl` (size-capped **data: URIs**, no
external host), `fontFamily` (system/rounded/serif), `themeMode`
(light/dark/auto), and `soundEnabled` (opt-in chime on agent replies). Edited at
**Settings → Website chat** with a live preview and copyable embed snippets for
every deploy mode.

## Transport

- **Visitor ↔ server:** a dedicated public Socket.io namespace **`/widget`**
  (`apps/api/src/webchatwidget/webchatwidget.gateway.ts`), SEPARATE from the
  agent-authenticated gateway. Auth = the public site key (`handshake.auth`) + an
  **origin allow-list** check; anonymous, WebSocket-only transport (so browser CORS
  never applies), per-IP handshake rate limit. A visitor only ever joins the room
  for THEIR OWN conversation (resolved server-side from the site key + visitor id).
- **Inbound:** `visitor:message` → a `NormalizedInboundMessage` →
  the same `ingestEvents(teamId, "webchatwidget", …)` every channel uses. Identity
  is `external` (`Contact.externalContactId = "${widgetId}:${visitorId}"`).
- **Outbound:** an agent/automation reply flows through the UNCHANGED outbound
  pipeline; `webchatwidgetProvider.sendText/sendMedia` do NO vendor I/O (they mint a
  local id + return sent). Delivery to the visitor is realtime:
  `WebchatwidgetDeliveryService` subscribes to `message.sent` / `message.received` /
  `message.status_changed` on the REALTIME tier and pushes to the visitor room.
- **Reliability (v2):** an offline send queue with optimistic bubbles + retry,
  refresh-safe persistence, and delivery/read receipts over the socket
  (`readReceipts` + `deliveryReceipts` capabilities). History is **paginated** —
  the gateway replays the latest `HISTORY_LIMIT` on connect and serves older
  pages via `visitor:loadOlder` (keyset `(timestamp,id)` cursor, `hasMore` flag);
  the widget lazy-loads earlier messages on scroll-up.
- **Typing (both directions):** agent typing relays to the visitor
  (`bindWidgetTypingRelay`); the visitor's `visitor:typing` relays to the agent
  conversation room as `conversation:visitor_typing`, so the inbox shows
  "<customer> is typing…" (cleared on the visitor's disconnect + an 8s safety
  auto-clear). Voice notes record in-browser (MediaRecorder) and upload as a
  `voice`-flagged audio message.

## Media

All message types both directions — text, image, video, audio/voice, document —
plus quoted replies. No reactions. The visitor uploads via `POST /api/widget/media`
(site-key + origin gated, mime-sniffed, → R2); the message is created media-ready.
Visitors fetch their own conversation's media via `GET /api/widget/media/:id`
(ownership scoped by site key + visitor id) which streams the private R2 object.

## Identity (pre-chat form)

A configurable, optional pre-chat form (name / email / phone). A provided
email/phone is treated as **self-asserted** and can auto-merge the visitor into a
unified `Customer` via the existing strong-key path
(`lib/identity/webchat-prechat.ts` → `findExistingCustomerIdByStrongKey` with
`trustEmailAsStrongKey`). No fuzzy/name matching (docs/identity.md).

## Automation / bots

The widget holds no bot logic — it plugs into the platform's two AI paths via the
existing seams (same as every other channel):

- **n8n autopilot** — each visitor message publishes `message.received` (forwarded
  by outbound webhooks); the flow replies via the `/v1` API (channel-agnostic
  send). "Customer says human" calls `/v1` `set-ai` with `{aiEnabled:false}`,
  which runs the team's configured **handoff policy** (assign / round-robin /
  unassign).
- **Native AI Assistant** — the reply orchestrator answers from the org's
  knowledge base; when it decides to **escalate**, it pauses the assistant
  (`ai_paused`) and applies the SAME handoff policy. Both paths share one helper,
  `lib/conversations/handoff.ts` (`runHandoffPolicy`), so assignment behaves
  identically whichever AI is driving.

## Not a broadcast target

A website visitor is reachable only while their browser tab holds a live socket —
there's no durable push address — so `webchatwidget` is **excluded from
broadcasts** (`BROADCASTABLE_CHANNELS` in `@ccp/shared/providers/capabilities`;
the composer's channel picker + `zBroadcastableChannel` schema + the customer-mode
best-channel resolver all gate on it). Widget contacts never appear as broadcast
recipients.

## Touch points

`prisma/schema.prisma` (`WebchatWidget` model, `Conversation.webchatWidgetId`,
`Channel.webchatwidget`); `@ccp/shared/providers/capabilities` (+ `LIVE_CHANNELS`);
`apps/api/src/lib/providers/webchatwidget*.ts` + registry;
`apps/api/src/webchatwidget/` (gateway, delivery, public controller, frame);
`apps/api/src/workspace-settings/webchatwidget/` (admin CRUD);
`apps/web/.../settings/webchatwidget/` (management UI + live preview + embed);
`apps/web/public/widget.js` + `apps/web/public/webchat/`.
