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

## Embed

```html
<script src="https://YOUR-APP/widget.js" data-webchat-key="wc_pk_..." defer></script>
```

`apps/web/public/widget.js` is a hand-written classic script (Shadow DOM, isolated
from the host page) that loads socket.io's UMD client from the same origin
(`/webchat/socket.io.min.js`) and connects. Test page:
`/webchat/test.html`.

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

## Automation / bots (future, seam-ready)

The widget holds no bot logic. An n8n webhook or org AI agent plugs in via the
existing seams: each visitor message publishes `message.received` (forwarded by
outbound webhooks), the bot replies via the `/v1` API (channel-agnostic send), and
"customer says human" is an automation-layer **assign** call. The `aiEnabled`
conversation flag already models bot-handling vs human-handling.

## Touch points

`prisma/schema.prisma` (`WebchatWidget` model, `Conversation.webchatWidgetId`,
`Channel.webchatwidget`); `@ccp/shared/providers/capabilities` (+ `LIVE_CHANNELS`);
`apps/api/src/lib/providers/webchatwidget*.ts` + registry;
`apps/api/src/webchatwidget/` (gateway, delivery, public controller, frame);
`apps/api/src/team/webchatwidget/` (admin CRUD);
`apps/web/.../settings/webchatwidget/` (management UI + live preview + embed);
`apps/web/public/widget.js` + `apps/web/public/webchat/`.
