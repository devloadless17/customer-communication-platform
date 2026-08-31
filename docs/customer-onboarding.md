# Customer onboarding runbook — WhatsApp channel

The full path from signup to a working shared inbox: every URL, field, and
Meta dashboard step, in the order it must happen. Follow it top to bottom on
each onboarding call.

> **Scope note.** This is an *operator process* doc, deliberately the only
> file in `docs/` (architecture detail lives beside the code — CLAUDE.md §20).
> It describes the product's actual connect flow; if that flow changes, update
> this file in the same commit.

Legend: **[You]** = platform operator · **[Customer]** = the client (often on a
screen-share).

---

## 0 · Before the call — what the customer should have ready **[Customer]**

Send this list ahead of time; it is the difference between a 20-minute call
and a two-hour one. All of it lives in the customer's Meta Business Manager.

- [ ] A **Meta Business Portfolio** with a **WhatsApp Business Account (WABA)**
      and a registered phone number in it.
- [ ] A **Meta developer app** (type: Business) with the **WhatsApp product**
      added, linked to that portfolio.
- [ ] A **permanent system-user token**:
      Business Settings → System users → create (Admin) → **assign BOTH
      assets**: the app *and* the WhatsApp account → Generate token, expiry
      *Never*, scopes `whatsapp_business_messaging`,
      `whatsapp_business_management`, `business_management`.
      Skipping the asset assignment is the classic "(#200) permissions" trap —
      the in-app form has a step-by-step for this.
- [ ] The **App Secret** (App Dashboard → Settings → Basic).
- [ ] If the number is still used in the WhatsApp Business phone app, it is a
      **Coexistence** number — extra webhook fields apply in phase 4.

## 1 · Sign up — this creates the organization **[Customer]**

There is no separate "create organization" step. One form does it all and
provisions their first workspace automatically (stages, starter flags, and a
#general team channel included).

- [ ] Customer opens `/register` and fills: organization name, their name,
      email, password.
- [ ] They verify their email with the OTP at `/verify`.
- [ ] They land on `/pending` — "awaiting approval". That's your cue.

## 2 · Approve the organization **[You]**

- [ ] Open `/platform` — the pending org is in the queue. One-click **Approve**.
- [ ] Optional: on the org's detail page, adjust **max workspaces** (default 2)
      and **max members** if their team needs more.
- [ ] The customer's pending page polls every 25 seconds — on approval it
      redirects them straight to `/settings/whatsapp`.

## 3 · Meta App credentials — `/settings/meta` first **[Customer]**

One set of app credentials serves WhatsApp, Messenger, and Instagram. Do this
page before the WhatsApp page.

> **Standard: ONE Meta app per client.** All their numbers, WABAs, Pages and
> IG accounts subscribe to that one app — one secret to rotate, one dashboard,
> one callback. (A client arriving with assets already split across two apps
> still onboards fine — per-connection credential overrides + multi-secret
> webhook verification handle it — but never *create* a second app.)

- [ ] Paste **App Secret** and **system-user token** (both required).
- [ ] Fill **App ID** too. Labelled optional, but with it the platform can
      verify "is *our* app subscribed to this WABA" precisely instead of
      guessing.
- [ ] Save — the platform validates the token against Meta before storing it.
      Read any warnings now, not later.
- [ ] Copy the two read-only values the page shows: **Callback URL** and
      **Verify token**. You never invent a verify token — it's minted for you.

## 4 · Meta App Dashboard — webhook + security settings **[Customer]**

In the customer's App Dashboard.

- [ ] **[You] — platform side, BEFORE the toggle below.** The platform only
      signs Graph calls with `appsecret_proof` when `META_APPSECRET_PROOF=1`;
      it is **off by default** (`apps/api/src/lib/providers/appsecret-proof.ts`),
      and with it off no proof is appended at all — so ticking Meta's toggle
      first breaks every Graph call for that client. Set
      `META_APPSECRET_PROOF=1` in the api's env and restart the api. The flag
      is process-wide, not per client, and each channel signs with the app
      secret that issued its own token; Meta accepts a correct proof whether
      or not an app requires one, so already-onboarded clients are unaffected.
- [ ] **Enable "Require app secret"**: App settings → **Advanced** → Security →
      toggle **Require app secret** ON. With the flag above set, the platform
      signs every Graph call with `appsecret_proof`, so this is safe here and
      blocks anyone using a leaked token without the secret. Leaving it in the
      wrong state has caused real API errors during past setups — set it
      deliberately, don't skip it.
- [ ] **[You]** Confirm with one live send once the number is connected (phase
      6 below covers it): the local Graph mock cannot validate a proof, so a
      real inbound + outbound round-trip is the only proof that the pair is
      set correctly.
- [ ] **Set the API version**: App settings → **Advanced** → Upgrade API
      version → match the platform's pinned Graph version (**v26.0** — the
      `META_GRAPH_VERSION` default in `apps/api/src/lib/providers/config.ts`).
      Outbound calls pin their version explicitly so this can't break them;
      what it aligns is the schema of the **webhook payloads** Meta delivers,
      which the parsers are audited against. Bump this doc when the code's
      pinned version moves.
- [ ] WhatsApp → Configuration: paste the **Callback URL** and **Verify token**
      from phase 3, hit Verify — the platform answers the handshake itself.
- [ ] Tick the **webhook fields**. `messages` is the hard requirement; tick
      the full set so template status, account health, and calling stay live:

      messages · message_template_status_update ·
      message_template_quality_update · message_template_components_update ·
      template_category_update · account_update · account_alerts ·
      account_review_update · business_capability_update ·
      phone_number_name_update · phone_number_quality_update ·
      business_username_updates · user_preferences · security · calls

- [ ] **Coexistence number?** Also tick `smb_message_echoes`, `history`, and
      `smb_app_state_sync` so replies sent from the phone app, past chats, and
      saved contact names sync into the inbox.

## 4b · Grant EVERYTHING now — while you have access **[Customer + You]**

Do this on the onboarding call, even for channels they will not use for
months. Every item here needs Business-Settings or App-Dashboard access, and
you may not have it later. Adding a scope or an asset afterwards means
regenerating the token — with access you no longer hold.

**Order matters:** add the Messenger + Instagram products/use cases to the app
BEFORE generating the token, or their permissions will not appear in the
token dialog at all ("an app admin may need to customize or add a use case").

- [ ] **System user = Admin, token expiry = Never.** An *admin* system user has
      full access to every asset the portfolio owns by default; an *employee*
      one needs each asset granted by hand. The token belongs to the BUSINESS,
      not to the person who clicked Generate — nobody leaving invalidates it.
      (Meta also offers a 60-day expiring variant; some businesses are forced
      onto it. If so, diarize the refresh — letting it lapse forfeits it.)
- [ ] **Assign every asset** to the system user, Full control: the app, every
      WABA, every Page, every Instagram account. (Redundant for an admin
      system user, harmless, and it survives a later downgrade.)
- [ ] **Every scope, in one token:**

      business_management · whatsapp_business_messaging ·
      whatsapp_business_management · whatsapp_business_manage_events ·
      pages_messaging · pages_manage_metadata · pages_show_list ·
      pages_read_engagement · instagram_basic · instagram_manage_messages ·
      instagram_manage_comments

      `business_management` is a DEPENDENCY of `pages_messaging`,
      `pages_show_list` and `instagram_manage_messages` — Meta asks you to
      call that out explicitly in an App Review submission. What each scope
      buys, and what breaks without it, is documented in
      [`apps/api/src/workspace-settings/meta/meta.service.ts`](../apps/api/src/workspace-settings/meta/meta.service.ts).
- [ ] **All three webhook topics**, one callback URL (`/webhooks/meta/<workspaceId>`)
      + the verify token from `/settings/meta`: `whatsapp_business_account`
      (fields per phase 4), `page`, and `instagram`. Subscribing a topic later
      needs dashboard access; subscribing it now costs nothing while the
      channel is unconnected.
- [ ] **Generate the FINAL token last**, and have the customer type it straight
      into `/settings/meta`. Rotating it later requires the access you are
      trying not to depend on.

## 4c · Switch the app to Live mode **[Customer]**

Meta's webhooks doc: *"Make sure your app is in Live mode; some webhooks will
not be sent if your app is in Dev mode."* In Development mode, Messenger and
Instagram deliver messages ONLY for people holding a role on the app — which
is exactly the "worked with my test account, silent for real customers"
report. **Check app mode before blaming App Review.**

The toggle sits at the top of the App Dashboard and stays locked until
Settings → Basic is complete. Each of these is individually marked *required
to switch your app to Live mode*:

- [ ] **Display Name**
- [ ] **Contact Email** (and verify it)
- [ ] **Privacy Policy URL**
- [ ] **Terms of Service URL**
- [ ] **App Icon**, 1024×1024 — must not contain Meta logos/trademarks or the
      words "Facebook"/"FB"
- [ ] **Category**
- [ ] **App Purpose / Business Use**
- [ ] **User Data Deletion** — Meta requires EITHER a data-deletion callback
      URL OR an instructions URL; a section of the privacy policy is
      explicitly acceptable. This platform implements the callback at
      `/webhooks/meta-data-deletion` if they prefer it.

Business Verification is **not** a Live-mode gate ("While verification is not
required to Go Live, you will not be able to access data you do not own until
verification is complete") — but see §6d, they need it anyway.

## 5 · Connect the number — `/settings/whatsapp` **[Customer]**

- [ ] Enter the **Phone Number ID** and the **WhatsApp Business Account ID** —
      both required, both in Meta Business Suite → WhatsApp → API Setup.
      Leave the advanced access-token override empty; it falls back to the
      phase-3 credentials.
- [ ] Hit **Validate & save**. The platform validates the number with Meta,
      confirms the WABA owns it, subscribes the app to the WABA, and starts
      the health poll — read the warnings banner if one appears; it says
      exactly what to fix.
- [ ] **Number still used in the WhatsApp Business PHONE app?** It cannot be
      verified or registered while the phone app holds it (Meta allows one
      home per number; Coexistence needs our pending Tech Provider approval).
      The client must migrate: back up phone chats (their record only — history
      never imports), then phone app → Settings → Account → **Delete account**
      to release the number. Tell-tale signs of this state: WhatsApp Manager
      shows the number **Offline**, Graph reads `is_on_biz_app: true` +
      `DISCONNECTED`, the WABA is labeled "WhatsApp Business app".
- [ ] If the number's status isn't **Connected**: first make sure the number
      is **OTP-verified** (WhatsApp Manager → Phone numbers — a number showing
      `NOT_VERIFIED` must complete the SMS/voice code before anything else),
      then run the register flow with a 6-digit two-step PIN (passed through
      to Meta, never stored). If the number ever had two-step enabled in the
      phone app, that EXISTING PIN is required — a wrong guess burns one of
      Meta's 10 attempts per 72h. An unverified, unregistered number saves
      cleanly, warns in the banner, and carries **zero traffic — inbound
      included** — until both steps are done.

## 6 · Verify end-to-end — five minutes, do not skip **[You]**

- [ ] **Inbound:** send a WhatsApp message from a personal phone to the
      customer's number — it appears in the inbox in realtime.
- [ ] **Outbound:** reply from the inbox — it arrives on the phone (you're
      inside the 24-hour window, so free-form text works).
- [ ] **Templates:** hit **Refresh** in the reply box's template picker — the
      catalog syncs on demand (it's empty until the first sync; a background
      sweeper also picks it up within 30 minutes).
- [ ] **Health:** the messaging-health panel on `/settings/whatsapp` shows
      tier, quality, and throughput. Use its refresh if the portfolio link is
      still resolving.

## 6b · Adding Messenger / Instagram — the Advanced Access gate **[Customer]**

WhatsApp inbound works as soon as the number is connected — Messenger and
Instagram do NOT. Two DIFFERENT gates produce the identical symptom ("worked
with my test account, silent for real customers"), and they are fixed in
different places. Check them in this order:

1. **App mode.** In Development mode these webhooks fire ONLY for users
   holding a role on the app. This is the common cause and costs nothing to
   fix — §4c.
2. **Advanced Access / App Review.** Standard Access limits data to users with
   a role on the app or Page. Meta's Messenger overview, however, states App
   Review is *"not required if you only send and receive messages for your own
   Facebook Page"* — which is this product's per-client-app shape. So do NOT
   assume App Review is the blocker: go Live, test from a NON-role account,
   and only submit if inbound is still silent. (An app serving OTHER
   businesses' Pages — the Tech Provider direction — does need it.)

- [ ] App switched to **Live** mode (top toggle in the App Dashboard).
- [ ] **Business verification** completed (Business Settings → Security
      Center) — mandatory for Advanced Access.
- [ ] App Review → Permissions & features: request **Advanced Access** for
      `pages_messaging` and `pages_manage_metadata` (Messenger) and
      `instagram_manage_messages` + `instagram_basic` (Instagram DMs).
- [ ] Instagram only: professional (Business/Creator) account linked to the
      Page, and in the Instagram app: Settings → Messages and story replies →
      **Connected tools → "Allow access to messages" ON** — without it DMs
      never reach any third-party tool, role or no role.
- [ ] Page uses another messaging app too (an old bot, a previous vendor)?
      Check the handover protocol: our app must be the Page's **primary
      receiver** or messages route to the other app.
- [ ] While App Review is pending, verify the plumbing by sending from an
      account that HAS a role on the app (admin/developer/tester) — those
      deliver under Standard Access.

## 6c · Post-onboarding verification — the truth check **[You]**

After connect (and again after registration), run the reconciler — it reads
every Meta-mirrored field fresh from Graph, diffs it against what the system
stores, and heals drift through the same paths production uses:

    # on the VPS
    docker compose exec --workdir /app api node -r @swc-node/register \
      apps/api/scripts/meta-reconcile.ts "<workspace name or id>"

Every row should read `ok` or carry an explained MANUAL remedy (registration,
phone-app migration). A `DRIFT` that survives a second run is a real bug —
report it, don't shrug. This tool caught a live tier-clobbering bug on its
first ever run (2026-08-11).

## 6d · Business verification + billing — the two silent blockers **[Customer]**

Neither blocks the connect flow, and both stop real traffic. Start them on the
onboarding call because verification takes days.

**Business Verification** (Business Settings → Security Center). Not required
to go Live, required for everything that matters afterwards:

- Raises the registered-number cap **2 → 20** (a `business_capability_update`
  webhook carries the new `max_phone_numbers_per_business`).
- Raises the portfolio messaging limit **250 → 2,000** — verification is one of
  Meta's named scaling paths, the alternative being 2,000 delivered messages.
- Is a hard prerequisite for **Advanced Access** on any permission.
- **Calling needs a messaging limit ≥ 2,000** (Meta error 138015), so
  verification is effectively a prerequisite for the calling feature.
- Is one of six criteria for **Official Business Account** (the blue check),
  alongside ≥30 days on the platform, an approved display name, two-step
  verification, notability in the press, and policy compliance.

**Billing.** A WABA with no working payment method fails every TEMPLATE send —
which is every broadcast and every out-of-window reply — with error **131042**.
That one code covers more than a missing card: payment account not attached,
credit line over limit or inactive, WABA deleted or suspended, and — easy to
miss — **timezone not set** or **currency not set** on the WABA. Calling has
the parallel error **131044**. Non-template messages inside the window are
free, so a broken billing setup looks fine right up until the first broadcast.

> Two irreversible choices to get right the first time: a WABA's **timezone and
> currency cannot be edited** once a line of credit is attached, and a credit
> line cannot be changed afterwards — fixing it means creating a new WABA.

## 7 · Set expectations for day one **[You]**

- [ ] **Messaging limit:** an unregistered number shows "Not assigned yet" —
      Meta grants the first tier at registration. A fresh portfolio then starts
      at **250 unique recipients per rolling 24h** (shared across every number
      in the portfolio) and grows with quality — don't plan a big broadcast on
      day one.
- [ ] **24-hour window:** free-form replies work for 24h after the customer's
      last message; outside it, only approved templates send.
- [ ] **Self-healing:** a webhook-health sweeper re-checks the Meta
      subscription every 30 minutes and repairs what it can. What it can't
      repair raises a reconnect banner on the settings page — that banner is
      the one signal worth watching.
- [ ] **Invite the team:** workspace members, roles, and assignment policies —
      once the channel is proven.
