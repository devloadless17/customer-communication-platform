# Messenger Calling API — build reference

Exact wire shapes for the **Messenger Business Calling API** (GA), captured from
Meta's docs. This is the source of truth for implementing Messenger calling in
`meta-social.ts` (provider methods + `parseWebhook` call events), the calls
domain, and the frontend WebRTC flow.

> **Key difference from WhatsApp calling** (don't assume they're identical):
> - The `connect` webhook carries **no SDP**. For a consumer→business call the
>   **business generates the SDP offer** and sends it on `accept`; Meta replies
>   with an **answer** (`sdp_response`) **and** a renegotiation **offer**
>   (`sdp_renegotiation`). WhatsApp instead delivers the customer's offer in the
>   webhook. So the existing `NormalizedCallEvent` SDP model + `use-call.ts`
>   signaling need a Messenger-specific path — this is NOT a capability flip.
> - Identity is Page + PSID (`from`/`recipient_id`), not phone.
> - Transport: WebRTC (audio+video), DTMF via RTP (no DTMF webhook).

## Eligibility (per Page)

```
POST /{page-id}/business_messaging_feature_status
{ "features": [ { "feature": "messenger_api_calling" } ] }
→ { "data": [ { "feature": "messenger_api_calling", "status": "enabled" } ] }
```
Gate the call button on `status === "enabled"`. This IS the region gate too:
Meta only returns `enabled` for Pages in the supported-country allow-list, so —
unlike WhatsApp (which gates the outbound button per contact-phone-country) —
Messenger needs NO per-contact country check (PSIDs carry no country). The
per-Page feature status is the single gate.

## Webhooks (field `calls`, `object: "page"`)

Subscribe to the `calls` field (and `call_permission_reply` for business-initiated).

**connect** — consumer- AND business-initiated; a call is initiated.
```json
{ "id": "c_...", "to": "{page-id}", "from": "{PSID}", "event": "connect",
  "timestamp": 1671644824, "call_direction": "business_initiated|user_initiated" }
```
`id` = call id (use in accept/reject/terminate). No SDP here.

**call_status** — business-initiated only.
```json
{ "id": "c_...", "event": "call_status", "timestamp": 1671644824,
  "recipient_id": "{PSID}", "call_status": "ringing|accepted" }
```

**media_update** — business-initiated only; carries Meta's SDP **offer** to answer.
```json
{ "id": "c_...", "event": "media_update", "timestamp": 1671644824,
  "session": { "version": 1, "sdp_renegotiation": { "sdp_type": "offer", "sdp": "<RFC4566>" } } }
```
Apply the highest `session.version`; generate an answer, apply to the local peer.

**terminate** — both directions; call ended for any reason.
```json
{ "id": "c_...", "event": "terminate", "timestamp": 1671644824,
  "status": "Completed|Failed", "start_time": 1671644824, "end_time": 1671644944, "duration": 120 }
```
`Completed` = finished normally (incl. rejected). `Failed` = failed mid-connection.
`duration` (seconds from business-connect) empty if the business never connected
→ treat as missed.

## Consumer → business (inbound) — accept / terminate

Accept within 60s of the `connect` webhook, sending YOUR SDP offer:
```
POST /{page-id}/calls
{ "call_id": "c_...", "action": "accept",
  "session": { "sdp": "<RFC4566 offer>", "sdp_type": "offer" } }
→ { "success": true,
    "session": { "sdp_response": "<answer>", "sdp_renegotiation": "<offer>" } }
```
Browser: `setRemoteDescription(answer=sdp_response)` then
`setRemoteDescription(offer=sdp_renegotiation)` → `createAnswer` → `setLocalDescription`.

Terminate:
```
POST /{page-id}/calls
{ "call_id": "c_...", "action": "terminate" }
→ { "success": true }
```
Reject (consumer-initiated only): `action: "reject"` (same endpoint) — TODO: confirm body on the reject-end-call sub-page.

## The unified endpoint — `POST /{page_id}/calls` (Graph v26.0)

Auth: `pages_messaging`. One endpoint, `action` discriminates. Request
(`PageCallsRequest`): `platform` ("messenger"|"instagram"|"whatsapp"),
`call_id`, `action` (`accept|connect|media_update|reject|terminate`), `to`
(PSID, for `connect`), `session:{sdp_type, sdp}`, `tracks[]` (msid/label/status,
≤4), `from_version`/`to_version` (renegotiation). Response
(`PageCallsResponse`): `success`, `call_id`, `session:{sdp_response:{sdp,sdp_type},
sdp_renegotiation?:{sdp,sdp_type}}`.

> Note `platform` accepts `instagram` — the SAME endpoint may serve IG calling
> when Meta ships it. Build the provider action generic over the social channel.

**Accept (inbound):** `{platform:"messenger", call_id, action:"accept",
session:{sdp_type:"offer", sdp:<our offer>}}` → `{success, session:{sdp_response:<answer>,
sdp_renegotiation?:<offer>}}`. Browser: apply answer, then (if present) the
renegotiation offer → createAnswer → setLocalDescription.

**Reject (inbound):** `{platform:"messenger", call_id, action:"reject"}` → `{success}`.
**Terminate (either):** `{platform:"messenger", call_id, action:"terminate"}` → `{success}`.

## Business → consumer (outbound)

1. **Check permission:** `GET /{page-id}/messenger_call_permissions?psid={psid}` →
   `{permission:{status:"no_permission"|"has_permission", expiration_time?}, actions:[
   {action_name:"send_call_permission_request", can_perform, limits:[{time_period, max_allowed, current_usage}]},
   {action_name:"start_call", can_perform}]}`. Permission lasts **7 days**;
   implicit permission after a fully-connected call OR after the consumer calls
   and the business doesn't pick up.
2. **Request permission** (≤2/thread/day): `POST /{page-id}/messages` with
   `{recipient:{id:psid}, message:{attachment:{type:"template",
   payload:{template_type:"calling_optin"}}}}` → consumer gets Accept/Decline.
3. **`call_permission_reply` webhook:** `{sender:{id:psid}, recipient:{id:page},
   timestamp, call_permission_reply:{response:"approve"|"reject", expiration_timestamp?}}`.
4. **Place call:** `POST /{page-id}/calls {platform:"messenger", to:psid,
   action:"connect", session:{sdp_type:"offer", sdp:<offer>}}` →
   `{success, id:call_id, session:{sdp_response:{sdp_type:"answer", sdp}}}`.
5. `call_status` (ringing→accepted) → `media_update` (answer its offer) → `terminate`.

## Call settings — `POST/GET /{page-id}/messenger_call_settings`

- `{icon_enabled:bool}` → `{result:"success"|"failure"}` — call-icon visibility.
- `{call_hours:{timezone_id, weekly_operating_hours:[{day_of_week, open_time"hhmm", close_time}]}}` → `{success}`; GET `?fields=call_hours`.
- `{call_routing:{ring_target:"META"|"PARTNERS"}}` → `{success}`; GET `?fields=call_routing`.
  **Critical:** to receive inbound calls in THIS app, `ring_target` must be
  `PARTNERS` (routes consumer-initiated calls to third-party apps, i.e. us).
  Requires the `calls` webhook subscription. Business-initiated calls work regardless.
- `call_prompt` template (Send API, `ttl_days` default 7) = a Call CTA button the
  consumer can tap to call us — the way to invite a call when the icon is hidden.
- **`call_settings_update` webhook:** `entry[].call_settings{audio_enabled,
  icon_enabled, call_routing, call_hours}` + `recipient_id`.

## Phase mapping → `NormalizedCallEvent`

| Messenger event | direction | phase | notes |
|---|---|---|---|
| `connect` (user_initiated) | in | `incoming` | no SDP (unlike WhatsApp); browser offers on accept |
| `connect` (business_initiated) | out | `ringing_out` | our placed call registered |
| `call_status: ringing` | out | `ringing_out` | (idempotent) |
| `call_status: accepted` | out | pickup → `connectedAt` | consumer answered |
| `media_update` | out | `connecting` | `sdp:{type:"offer"}` from `sdp_renegotiation` |
| `terminate` (Completed, duration>0) | — | `completed` | `connectedAt=start_time`, `durationSeconds=duration` |
| `terminate` (Completed, no duration) | — | `missed` | never connected |
| `terminate` (Failed) | — | `failed` | |

Metrics: submit call-quality metrics after each call (see the metrics sub-page).
