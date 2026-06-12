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
       YES → Google Sheets (org info) → AI Agent (Claude)
                 │
            Did the AI decide it needs a human?
                 │
         NO ─────┴───── YES
         │               │
   Send the reply   Pause AI + assign to a human  (send nothing to the customer)
```

Two distinct things happen, and they are easy to mix up:

| | What it is | When |
|---|---|---|
| **Read `ai_enabled`** | A field on every inbound webhook. No API call. | Every message — it's the gate. |
| **POST `…/ai`** | A one-time "pause the AI" switch. | **Only** when the AI escalates to a human. |

You never call anything to *resume* — a human resumes by closing the chat
(auto-resume) or clicking **AI on** in the inbox.

## Setup (platform side)

1. Create an **API key**: app → Settings → Integrations → **Organization API keys** → Create (Full access, or scopes `write:messages` + `write:conversations` + `read:conversations`). Copy the `ccp_…` token.
2. Create an **Outbound webhook**: Settings → Integrations → Webhooks → URL = your n8n Webhook URL, event = `message.received`.
3. `YOUR_APP_HOST` below = the app's public URL (e.g. `https://app.example.com`, no port). It must be reachable from your n8n box. In local dev the app is on `localhost:4000`; expose it with a tunnel (`cloudflared tunnel --url http://localhost:4000`) for n8n cloud to reach it.

## The inbound webhook payload (what n8n receives)

Relevant fields (camelCase; the message text is double-nested):

```jsonc
{
  "event_type": "message.received",
  "ai_enabled": true,                 // ← the gate
  "contact":  { "id": "...", "phoneNumber": "961...", "name": "..." },
  "assignee": null,                   // a human assignee (or null)
  "message": {
    "messageId": "cmq...",            // ← use as Idempotency-Key
    "conversationId": "cmq...",       // ← reply target
    "message": { "type": "text", "text": "1" }   // ← customer text at .message.text
  }
}
```

## The n8n nodes

### 1. Webhook (trigger)
POST, path e.g. `whatsapp-incoming`, respond immediately. Its URL goes in the
outbound-webhook config above.

### 2. IF — "Is AI allowed to answer?"
- Condition (boolean): `{{ $json.ai_enabled }}` is `true`
- **false →** stop (no further nodes). A human owns the conversation.
- **true →** continue.

### 3. Google Sheets — Get Row(s)
Read your org-info sheet. Output feeds the agent's knowledge.

### 4. AI Agent (Anthropic Claude)
- Chat model: `claude-sonnet-4-6` (or `claude-haiku-4-5` for speed/cost).
- Text: `={{ $('Webhook').item.json.message.message.text }}`
- System message — give it an escape hatch:
  > Answer the customer using ONLY the organization info below. If you cannot
  > fully help (needs a human, billing/refund dispute, angry customer, or they
  > ask for a person), reply with EXACTLY `<<HANDOFF>>` on the first line, then
  > a one-line reason. Never guess.
  > Organization info: `={{ JSON.stringify($('Google Sheets').all().map(i => i.json)) }}`

### 5. IF — "Does the AI need a human?"
- Condition: `{{ $json.output }}` starts with `<<HANDOFF>>`
- **false →** node 6a (reply). **true →** node 6b (escalate).

### 6a. HTTP Request — send the AI reply to the customer
This is the normal path.

| Field | Value |
|---|---|
| Method | `POST` |
| URL | `={{ "https://YOUR_APP_HOST/api/external/v1/conversations/" + $('Webhook').item.json.message.conversationId + "/messages" }}` |
| Send Headers | ON |
| → Authorization | `Bearer ccp_YOUR_KEY` |
| → Idempotency-Key | `={{ $('Webhook').item.json.message.messageId }}` |
| → Content-Type | `application/json` |
| Send Body | ON · JSON |
| → JSON | `={{ JSON.stringify({ body: $json.output }) }}` |

The `Idempotency-Key` (the inbound message id) makes n8n's retry-after-timeout
safe — the same key never double-sends to WhatsApp. (It's required on send
routes.)

### 6b. HTTP Request — escalate to a human (pause the AI)
The only place you POST to `…/ai`. Send NOTHING to the customer here.

| Field | Value |
|---|---|
| Method | `POST` |
| URL | `={{ "https://YOUR_APP_HOST/api/external/v1/conversations/" + $('Webhook').item.json.message.conversationId + "/ai" }}` |
| Headers | `Authorization: Bearer ccp_YOUR_KEY`, `Content-Type: application/json` |
| JSON body | `{ "aiEnabled": false, "silent": true }` |

Optional follow-ups in the same branch (give the human context / route it):
- `POST …/conversations/:id/notes` → `{ "body": "🤖→👤 AI handoff: <reason>" }`
- `POST …/conversations/:id/assign` → `{ "assignedUserId": "<a teammate id>" }`
- optionally send the customer a bridge message via `…/messages`
  ("Let me connect you with a teammate, one moment 🙏").

After this, every new inbound for that conversation arrives with
`ai_enabled: false`, so the IF gate in node 2 keeps the AI quiet.

## Handoff & resume — what happens automatically (no n8n needed)

- A **human reply in the inbox** auto-pauses the AI (`ai_enabled → false`) — replying *is* the takeover.
- **Closing** the conversation auto-resumes the AI (`ai_enabled → true`) for next time.
- An agent can also flip it manually with the **AI Autopilot** toggle in the conversation header.
- A `conversation.ai_changed` outbound webhook fires on every toggle, if you want n8n to observe handoffs.

## Loop safety

- The webhook only fires on `message.received` (inbound). The AI's reply is an
  *outbound* `message.sent`, which n8n is not subscribed to — no loop.
- `X-CCP-Depth` chain guard caps relayed chains; `silent: true` on the `…/ai`
  call skips the webhook echo of the AI's own pause.
