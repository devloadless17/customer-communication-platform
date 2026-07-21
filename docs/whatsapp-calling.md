# WhatsApp Business Calling — implementation guide

How calling works in this codebase, which rules come from Meta (and where), and
what phase 2 (recording + transcription) needs. The vendored Meta reference is
[docs/Meta/whatsapp.md](Meta/whatsapp.md); the calling material runs from line
9785 to the end of that file.

> **The one rule to internalize.** Meta owns the calling rules — permission,
> quotas, grant validity, regional eligibility, enforcement. We read them; we do
> not reconstruct them. The first implementation of this feature guessed at all
> of it and got every guess wrong, in ways that silently disabled outbound
> calling. When you're tempted to cache a limit or compute an expiry, don't.

---

## 1. The two wire shapes

Conflating these was the original defect, so keep them separate in your head:

| Concern | Endpoint | Notes |
|---|---|---|
| **Call signaling** | `POST /{phoneNumberId}/calls` | One endpoint, discriminated by `action`: `connect` · `pre_accept` · `accept` · `reject` · `terminate` |
| **Asking for permission** | `POST /{phoneNumberId}/messages` | An ordinary interactive message (`interactive.type = "call_permission_request"`). Billed like any message. **Not** a calling endpoint |
| **Reading permission** | `GET /{phoneNumberId}/call_permissions` | Authoritative state **and** live quota |
| **Configuring calling** | `POST /{phoneNumberId}/settings` | Enable/disable, call icon, callback permission, call hours |

There is no `/call_permission_requests` edge. An earlier version invented one,
so no permission request ever reached a customer and every out-of-window call
was refused forever.

**Send only documented body fields.** Graph rejects unknown parameters with
`(#100) Invalid parameter`, so a stray field fails the whole request rather than
being ignored. `from` on connect and `reject_reason` on reject were both
non-existent; the latter sat on the live decline path.

## 2. Webhooks

Three distinct shapes arrive under `field: "calls"` and `field: "messages"`:

| What | Where | Values |
|---|---|---|
| Call lifecycle | `value.calls[]` → `event` | `connect` · `terminate` · `call_created` (SIP only) |
| Call **progress** | `value.statuses[]` → `status`, with `type: "call"` | `RINGING` · `ACCEPTED` · `REJECTED` |
| Permission decisions | `value.messages[].interactive` | `call_permission_reply` |
| Failure reason | `value.errors[]` | Only on a FAILED terminate |

Three traps, each of which we hit:

- **`statuses[]` is overloaded.** Without checking `type === "call"` it all goes
  to the message-delivery handler, which silently drops every call status —
  including `ACCEPTED`, the only live "the customer picked up" signal Meta
  sends. We compensated for its absence with a browser heuristic that watched
  RTP packet counts, which ringback tone can trip.
- **Permission replies are MESSAGES.** Waiting for a `permission_granted` event
  in `calls[]` waits forever — and the customer's "Allow" renders as a junk
  "💬 Interactive reply" bubble in the thread.
- **`connect` is not pickup.** On an outbound call it's media setup, arriving
  about a second after dialing. The row stays `ringing` until `ACCEPTED`.

**Answered vs not, at terminate.** Terminate carries only `COMPLETED` or
`FAILED` — an unanswered call also terminates as `COMPLETED`. The discriminator
is the presence of `start_time`/`duration`, documented as present "only when the
call was picked up by the other party". This is doc-confirmed, not a heuristic;
don't "simplify" it into reading `status`.

## 3. Permission

Required for **every** business-initiated call. There is no 24h-window
exemption — the window only decides how you may ASK (a free-form message inside
it, an approved template outside it).

Three ways a customer grants it, and this is why the gate must be a provider
read:

1. Responding to a request message we sent.
2. **Automatically, by calling us** (when `callback_permission_status` is on).
3. **From the business profile**, unprompted.

Only the first leaves any trace on our side. A local ledger therefore refuses
contacts who are perfectly callable — which is exactly what ours did.

`GET /call_permissions` returns `permission.status`
(`no_permission`|`temporary`|`permanent`) plus per-action `limits[]` with
`can_perform_action` already computed across every window. Trust that verdict:
the per-user connected-call limit has moved 5 → 10 → 100 in a year, so any
number hardcoded here is wrong by the next changelog entry.

Grants are **7 days** for temporary, or permanent with no expiry. Take
`expiration_timestamp` from the reply webhook verbatim — Meta sends **no
webhook when a temporary permission lapses**, so a locally-computed duration is
unverifiable and silently discards days of a live grant. (We used 72h.)

`CallPermissionRequest` rows are a **cache and audit trail**, never the gate.

**Consecutive unanswered calls:** at 2, Meta nudges the customer to reconsider;
at 4, it revokes permission automatically (arriving as `response: "reject"` with
`response_source: "automatic"`).

## 4. Region

Eligibility follows **our business number's** country, not the customer's:

> "The business phone number's country code must be in this supported list. The
> consumer phone number can be from any country where Cloud API is available."

Blocked for business-initiated calling: US, CA, EG, VN, NG. Inbound works
everywhere. Reading this backwards fails both ways at once — refusing legitimate
calls to customers in blocked markets, and permitting calls from a business
number Meta will reject. See
[calling-regions.ts](../packages/shared/src/providers/calling-regions.ts).

## 5. The accept handshake

`pre_accept` and `accept` are two hops **on purpose**:

> "Since the WebRTC connection is established before calling the Accept Call
> endpoint, make sure to flow the call media only after you receive a 200 OK
> response back. If call media flows too early, the caller will miss the first
> few words of the call."

So: `POST /answer` issues `pre_accept` → the browser waits for
`connectionState === "connected"` with its mic held → `POST /accept-media`
issues `accept` → the browser unmutes. Firing both back-to-back in one request
defeats the mechanism entirely, which is what we did.

Meta allows roughly 30-60s from the incoming-call webhook to accept, after which
it terminates the call itself as "Not Answered". The stale-call sweeper's
ringing threshold is sized against that envelope.

## 6. Media

Meta is **ICE-LITE** — its candidates are inline in the SDP, so there's no
trickle to forward and no reason to wait for local gathering before POSTing.
Mandatory: Opus at 48 kHz, `ptime` 20 ms, a **single audio SSRC** (multiple
SSRCs cause "severe media corruption"), DTMF at 8 kHz. A standard Chrome
`RTCPeerConnection` satisfies all of it by default.

**Never expose an audio-codec setting.** G.711 exists only for PSTN/PBX
interop — which Meta's terms forbid on any leg of a WhatsApp call anyway — and
selecting it forces transcoding down to 8 kHz narrowband, degrading both the
recording and transcription accuracy in phase 2.

## 7. Enforcement

Meta pauses calling on a number (~7 days) over negative user feedback or a low
call-pickup rate, and warns first. Both arrive on `account_update`
(`ACCOUNT_VIOLATION` → warning, `ACCOUNT_RESTRICTION` → active pause) and land
on `ChannelConnection.calling*` columns. While restricted, every call **and**
every permission request fails — so without ingesting this a tenant sees a week
of unexplained errors and support can't tell enforcement from a bug.

The documented remedy for a low-pickup flag is to hide the call icon
(`call_icon_visibility: "DISABLE_ALL"`), which the settings surface exposes.

## 8. SIP — do not enable

> "When SIP is enabled, you **cannot use calling-related Graph API endpoints**."

SIP replaces Graph signaling and moves media termination onto a SIP server we'd
have to build and operate. Enabling it on a number breaks the entire
implementation described above **and** forfeits Meta-side recording and
transcription, since those are configured on the Graph `POST /calls` body. It's
a future pivot justified only by a named requirement (IVR, extension routing,
desk phones), and it's a per-number decision.

---

## 9. Phase 2 — recording and transcription

**Meta records and transcribes server-side. We do not touch the media.**

Both are per-call opt-in, added as an object on the same `POST /calls` body we
already send (`connect` for outbound, `accept` for inbound):

```json
"recording":     { "status": "ENABLED", "purpose": "...", "announcement_language": "en_US" },
"transcription": { "status": "ENABLED", "purpose": "...", "announcement_language": "en_US" }
```

Results arrive as `calls` webhook events — `call_recording_available` and
`call_transcription_available` — each carrying a media id. Audio is
`audio/ogg; codecs=opus`; the transcript is JSON, **stereo-separated by speaker**
(`channel 0` = business, `1` = customer) with word-level timestamps and
auto-detected language. Download URLs are valid 5 minutes; the media itself
lives **7 days**.

They are independent features, separately priced. When both are on, the
**recording** object's `purpose` and `announcement_language` are used for the
combined announcement and transcription's are ignored.

**Do not build browser-side `MediaRecorder` capture.** It produces a strictly
worse artifact (a mono mix, destroying the channel separation that makes the
transcript speaker-accurate) at higher engineering and legal risk, and it dies
with the agent's tab.

**Do not build our own transcription** with the AI stack. Meta's is
stereo-separated, word-timestamped, and free of our inference cost. The existing
`transcribeInboundAudio` path is for voice *notes* and stays separate.

### Consent

`purpose` is mandatory when recording is enabled (max 250 chars) and is **spoken
aloud to both parties** before recording starts, in `announcement_language`.
Calls with recording enabled and no purpose are rejected.

This belongs in **team settings**, never as agent free-text — it's a legal
string going into a customer's ear. Meta's only compliance mechanism is the
forced announcement plus the caller's ability to hang up; anything beyond that
(two-party-consent jurisdictions, GDPR basis, retention policy) is ours.

### Decisions to honor when building it

- **R2 key prefix: `calls/{teamId}/{yyyy}/{mm}/{externalCallIdShort}-recording.ogg`**
  and `-transcript.json`. This is the one expensive-to-reverse decision:
  [blob-orphan.ts](../apps/api/src/lib/sweepers/blob-orphan.ts) distinguishes
  categories **by key prefix**, so getting it wrong means the sweeper deletes
  recordings. Call artifacts are not `Message` media and must not be
  cross-checked against a `mediaKey` column.
- **Models, not columns on `Call`.** `CallRecording` / `CallTranscript`, each
  `@@unique([teamId, callId])` for at-least-once idempotency. Migration
  `20260530180000_drop_call_recording_seam` correctly dropped the earlier
  speculative columns — don't re-add them.
- **Artifacts must not move `Call.status`.** They arrive minutes after the call
  and carry no lifecycle meaning. New additive events
  `call.recording_available` / `call.transcript_available`, scoped to the
  conversation room per §10 of the handbook.
- **Download on a BullMQ job** with `jobId` = the media id. The URL expires in 5
  minutes but the media lives 7 days, so retries can be generous.
- **Capability flags** (`callRecording` / `callTranscription` on
  `ProviderCapabilities`) when the first consumer exists — not before.
- **Retention + erasure is ours.** Meta keeps nothing past 7 days. Whatever we
  store must participate in the contact hard-purge path.

### Already in place

- `mapMetaCallPhase` **logs** unhandled call events rather than dropping them
  silently, so enabling recording on the Meta side is immediately visible rather
  than vanishing without trace.
- `NormalizedCallEvent` carries `ctaPayload` / `deeplinkPayload` for call-button
  and deep-link attribution.
- The recording decision belongs in `CallsService` and is translated by the
  provider — keep it that way; never an `if (teamId === ...)` in the provider.

---

## 10. File map

| Concern | File |
|---|---|
| Wire layer (endpoints, webhook parsing, settings) | [meta.ts](../apps/api/src/lib/providers/meta.ts) |
| Webhook → DB, lifecycle state machine, permission events | [ingest-call.ts](../apps/api/src/lib/providers/ingest-call.ts) |
| Domain: pre-flight, answer/reject/end, settings, readiness | [calls.service.ts](../apps/api/src/calls/calls.service.ts) |
| Channel-agnostic calling adapter | [call-actions.ts](../apps/api/src/lib/messaging/call-actions.ts) |
| Region rules | [calling-regions.ts](../packages/shared/src/providers/calling-regions.ts) |
| Browser WebRTC | [use-call.ts](../apps/web/src/features/calls/hooks/use-call.ts) |
| Stuck-call recovery | [stale-calls.ts](../apps/api/src/lib/sweepers/stale-calls.ts) |
| e2e | [calls.spec.ts](../tests/e2e/calls/calls.spec.ts) |
