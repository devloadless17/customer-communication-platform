# n8n AI agent + AI Autopilot (human ↔ AI handoff)

How to wire an n8n flow that auto-replies to WhatsApp customers with an AI
agent, and cleanly hands a conversation to a human when needed — without the
AI ever talking over the human.

## The big picture

```
Customer texts you on WhatsApp
  └─ App fires an outbound webhook ──▶ n8n Webhook node   (event: message.received)
        the payload includes  ai_enabled: true | false   ← the gate
        │
        ▼
   IF  ai_enabled == true ?
        │
   NO ──┴── STOP. A human is handling it. Send nothing.
        │
       YES → Did the customer ask for a human? (message contains "human")
                 │
         NO ─────┴───── YES
         │               │
   Sheets → AI Agent   Pause AI + assign to a human  (send nothing to the customer)
   → Send the reply
```

Two distinct things happen, and they are easy to mix up:

| | What it is | When |
|---|---|---|
| **Read `ai_enabled`** | A field on every inbound webhook. No API call. | Every message — it's the gate. |
| **POST `…/ai`** | A one-time "pause the AI" switch. | **Only** when the AI escalates to a human. |

You never call anything to *resume* — a human resumes by closing the chat
(auto-resume) or clicking **AI on** in the inbox.

## Setup (platform side)

0. **Turn on AI Autopilot** for the org: app → Settings → Integrations → flip the **AI Autopilot** switch on. (Off by default — until it's on, the inbox AI toggle is hidden and auto-pause-on-reply doesn't fire, so orgs not using AI see nothing.)
1. Create an **API key**: app → Settings → Integrations → **Organization API keys** → Create (Full access, or scopes `write:messages` + `write:conversations` + `read:conversations`). Copy the `ccp_…` token.
2. Create an **Outbound webhook**: Settings → Integrations → Webhooks → URL = your n8n Webhook URL, event = `message.received`.
3. `YOUR_APP_HOST` below = the app's public URL (e.g. `https://app.example.com`, no port). It must be reachable from your n8n box. In local dev the app is on `localhost:4000`; expose it with a tunnel — `ngrok http 4000` (→ `https://<id>.ngrok-free.dev`) or `cloudflared tunnel --url http://localhost:4000` — and use that host. With ngrok's free tier, add header `ngrok-skip-browser-warning: true` on the HTTP Request nodes so the interstitial never intercepts a call.

## The inbound webhook payload (what n8n receives)

Relevant fields (camelCase; the message text is double-nested):

```jsonc
{
  "event_type": "message.received",
  "timestamp": 1718539200000,         // ← event time (epoch ms), on every event
  "ai_enabled": true,                 // ← the gate
  // Present ONLY when ai_enabled was forced false for a reason other than a
  // pause — today: "first_touch_workflow" (org chose a welcome workflow to
  // greet, so the AI is muted on this conversation's first message only).
  "ai_suppressed_reason": null,
  // Where this inbound sits in the chatting session — greet differently per
  // value without tracking session state yourself:
  //   first_ever | returning_session | continued
  "session_kind": "first_ever",
  "contact":  { "id": "...", "phoneNumber": "961...", "name": "..." },
  "assignee": null,                   // a human assignee (or null)
  "conversation": {                   // ← thread state, no callback needed
    "id": "cmq...",                   //    same id as message.conversationId
    "status": "open",
    "unreadCount": 1,
    "isNewConversation": false,
    "reopened": false
  },
  "message": {
    "messageId": "cmq...",            // ← use as Idempotency-Key
    "conversationId": "cmq...",       // ← reply target
    "message": { "type": "text", "text": "1" }   // ← customer text at .message.text
  }
}
```

> The full payload also carries `channel`, `sender`, and (on media messages)
> `message.media` with file links. Every event includes the top-level
> `timestamp`; correlation ids appear as `conversation.id` + `message.conversationId`
> (same value) and `contact.id`. Auth + dedup ride on headers: `X-CCP-Signature`
> (HMAC-SHA256 of the body), `X-CCP-Delivery` (unique id), `X-CCP-Event`.

> **n8n wraps the POST body under `json.body`.** So inside n8n you reference
> these fields as `$json.body.ai_enabled`, `$('Webhook').item.json.body.message.
> conversationId`, etc. (not `$json.ai_enabled`). The expressions below already
> include `.body`.

## The n8n nodes

### 1. Webhook (trigger)
POST, path e.g. `whatsapp-incoming`, respond immediately. Its URL goes in the
outbound-webhook config above.

### 2. IF — "Is AI allowed to answer?"
- Condition (boolean): `{{ $json.body.ai_enabled }}` is `true`
- **false →** stop (no further nodes). A human owns the conversation.
- **true →** continue.

### 3. Google Sheets — Get Row(s)
Read your org-info sheet. Output feeds the agent's knowledge.

### 3b. Limit — collapse the sheet to ONE item  ⚠️ important
A sheet with N rows outputs **N items**, and n8n runs every downstream node
**once per item** — so without this the AI Agent and the reply would fire N
times (N AI calls, N sends). Add a **Limit** node (Max Items = `1`) right after
the Sheets node. The agent still reads ALL rows via
`$('Get row(s) in sheet').all()` in its system message; this just makes the
chain run once. (An **Aggregate** node "combine all into one" works too.)

### "Customer wants a human?" IF — place it right after the gate (before Sheets)
Handoff is decided by the CUSTOMER's words, so check the inbound message — no
need to run the AI first.
- Value 1: `={{ ($('Webhook').item.json.body.message.message.text || "").toLowerCase() }}`
- Operation: String **contains** · Value 2: `human`
  (the `|| ""` guards against a media-only message that has no `.text`.)
- **true →** escalate (node 6b). **false →** continue to Sheets → AI (node 4).
- (Optional: add an OR condition with `agent` / `representative` to catch more.)

### 4. AI Agent (Anthropic Claude)  — runs only on the "false" (no-human) branch
- Chat model: `claude-sonnet-4-6` (or `claude-haiku-4-5` for speed/cost).
- Text: `={{ $('Webhook').item.json.body.message.message.text }}`
- System message:
  > Answer the customer using ONLY the organization info below. Keep replies
  > short, friendly, plain text. Never invent details.
  > Organization info: `={{ JSON.stringify($('Get row(s) in sheet').all().map(i => i.json)) }}`

### 6a. HTTP Request — send the AI reply to the customer
This is the normal path.

| Field | Value |
|---|---|
| Method | `POST` |
| URL | `={{ "https://YOUR_APP_HOST/api/external/v1/conversations/" + $('Webhook').item.json.body.message.conversationId + "/messages" }}` |
| Send Headers | ON |
| → Authorization | `Bearer ccp_YOUR_KEY` |
| → Idempotency-Key | `={{ $('Webhook').item.json.body.message.messageId }}` |
| → Content-Type | `application/json` |
| Send Body | ON · JSON |
| → JSON | `={{ JSON.stringify({ body: $json.output, onlyIfAiEnabled: true }) }}` |

The `Idempotency-Key` (the inbound message id) makes n8n's retry-after-timeout
safe — the same key never double-sends to WhatsApp. (It's required on send
routes.)

**`onlyIfAiEnabled: true` is the no-interrupt guard.** If a human (or the
customer typing "human") took over WHILE the AI was generating, AI Autopilot is
already paused — and the platform then **skips this send** server-side
(returns `200 { "ok": true, "skipped": "ai_disabled", "message": null }`, no
WhatsApp send). So the AI can never land a message on top of a live
human↔customer chat, even in the race window. No client-side re-check needed.

### 6b. HTTP Request — escalate to a human (pause the AI)
The only place you POST to `…/ai`. Send NOTHING to the customer here.

| Field | Value |
|---|---|
| Method | `POST` |
| URL | `={{ "https://YOUR_APP_HOST/api/external/v1/conversations/" + $('Webhook').item.json.body.message.conversationId + "/ai" }}` |
| Headers | `Authorization: Bearer ccp_YOUR_KEY`, `Content-Type: application/json` |
| JSON body | `{ "aiEnabled": false, "silent": true, "applyHandoffPolicy": true }` |

**`applyHandoffPolicy: true`** marks this as a CUSTOMER-initiated handoff, so the
platform runs the org's configured handoff action AFTER pausing the AI — leave
unassigned, assign to a fixed member, or **round-robin** to available agents
(set under Settings → Integrations → AI Autopilot). Omit it (or send `false`)
and only the pause happens. The action runs once, only on the actual
true→false flip — a retry is a no-op. You no longer need a separate `…/assign`
call for the common case; the platform does it for you.

Optional follow-ups in the same branch (give the human context / route it):
- `POST …/conversations/:id/notes` → `{ "body": "🤖→👤 AI handoff: <reason>" }`
- `POST …/conversations/:id/assign` → `{ "assignedUserId": "<a teammate id>" }`
  (only if you want to OVERRIDE the configured handoff action for this case)
- optionally send the customer a bridge message via `…/messages`
  ("Let me connect you with a teammate, one moment 🙏").

After this, every new inbound for that conversation arrives with
`ai_enabled: false`, so the IF gate in node 2 keeps the AI quiet.

## Handoff & resume — what happens automatically (no n8n needed)

- A **human reply in the inbox** auto-pauses the AI (`ai_enabled → false`) — replying *is* the takeover.
- **Closing** the conversation auto-resumes the AI (`ai_enabled → true`) for next time.
- An agent can also flip it manually with the **AI Autopilot** toggle in the conversation header.
- A `conversation.ai_changed` outbound webhook fires on every toggle, if you want n8n to observe handoffs.
- On a customer handoff sent with `applyHandoffPolicy: true`, the platform also
  applies the org's **handoff action** (unassign / assign-fixed / round-robin) —
  configured under Settings → Integrations → AI Autopilot.

## First-touch greeting & `session_kind`

- **First-touch greeter** (Settings → Integrations → AI Autopilot): if set to
  *Workflow greets*, the platform forces `ai_enabled: false` on a brand-new
  conversation's FIRST inbound (with `ai_suppressed_reason: "first_touch_workflow"`)
  so your in-app welcome workflow greets and the AI doesn't double-text. The 2nd
  message onward arrives with `ai_enabled: true`. Existing flows need NO change —
  they already gate on `ai_enabled`. Default *AI greets* = no suppression.
- **`session_kind`** (`first_ever` | `returning_session` | `continued`) lets you
  branch the greeting: e.g. "Welcome!" on `first_ever`, "Welcome back!" on
  `returning_session`, and skip the greeting on `continued`. A new session starts
  after the org's configured inbound-silence gap (default 6h) or a reopen. In-app
  workflows can match the same value via the `Session` condition on the
  *Message Received* trigger.

## Sample Google Sheet data (to test with)

Create a sheet named `OrgInfo` with two columns — `topic` and `details` — and
paste these rows. The AI Agent reads the whole sheet as its knowledge base.

| topic | details |
|---|---|
| Business name | Bean & Brew Coffee |
| Hours | Mon–Fri 7am–7pm, Sat–Sun 8am–5pm |
| Location | 12 Hamra Street, Beirut. Dine-in + takeaway. |
| Delivery | Free delivery over $20 within Beirut, 30–45 min |
| Menu & prices | Espresso $2, Latte $3.5, Cappuccino $3.5, Cold brew $4, Croissant $2 |
| Payment | Cash, card, and WhatsApp Pay |
| Loyalty | 10th coffee free with the Bean & Brew card |
| Allergens | Oat & almond milk available; products may contain nut traces |
| Refunds & complaints | A human teammate handles these case by case — escalate |
| Catering & wholesale | A human handles catering quotes — escalate |

Test questions and what should happen:
- "What time do you open on Saturday?" → AI answers (8am).
- "How much is a latte?" → AI answers ($3.50).
- "Do you deliver to Hamra?" → AI answers (yes, free over $20).
- "I want a refund for my order" → AI replies `<<HANDOFF>>` → escalation branch.
- "Can you cater 50 coffees for an event?" → `<<HANDOFF>>` → escalation branch.

## Testing the flow WITHOUT WhatsApp

You don't need a real WhatsApp message to test the n8n logic. In the Webhook
node click **Listen for test event**, then POST a sample inbound payload to the
node's test URL:

```bash
curl -X POST 'https://YOUR_N8N/webhook-test/whatsapp-incoming' \
  -H 'Content-Type: application/json' \
  -d '{
    "event_type": "message.received",
    "ai_enabled": true,
    "contact": { "id": "c_test", "phoneNumber": "96170000000", "name": "Test Customer" },
    "assignee": null,
    "message": {
      "messageId": "test_msg_1",
      "conversationId": "test_conv_1",
      "message": { "type": "text", "text": "What time do you open on Saturday?" }
    }
  }'
```

Change `message.message.text` to `"I want a refund"` to exercise the handoff
branch. (The final reply HTTP node will only succeed against a REAL
conversationId once you're sending live WhatsApp messages — for pure logic
testing, disable/mock that last node or watch the branch it takes.)

> Reachability for the live reply: your app is on `localhost:4000`; n8n at
> `marketing.bbcorp.trade` can't reach localhost. Expose it for a live test —
> `cloudflared tunnel --url http://localhost:4000` — and use that host as
> `YOUR_APP_HOST`. The inbound webhook direction works regardless (your app
> calls out to n8n).

## Loop safety

- The webhook only fires on `message.received` (inbound). The AI's reply is an
  *outbound* `message.sent`, which n8n is not subscribed to — no loop.
- `X-CCP-Depth` chain guard caps relayed chains; `silent: true` on the `…/ai`
  call skips the webhook echo of the AI's own pause.
- **Forward `X-CCP-Depth` verbatim** on every `/v1` call your flow makes from a
  webhook (the reply send, the `…/ai` toggle, tag/status writes). Copy it from
  the inbound request headers to the HTTP node's headers. We increment it per
  hop and reject at depth 8 — that's what stops an accidental loop cheaply.
  Without it, only the 30/min per-conversation rate limit guards you.
