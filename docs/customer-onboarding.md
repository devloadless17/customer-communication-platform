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

- [ ] **Enable "Require app secret"**: App settings → **Advanced** → Security →
      toggle **Require app secret** ON. The platform signs every Graph call
      with `appsecret_proof`, so this is safe here and blocks anyone using a
      leaked token without the secret. Leaving it in the wrong state has
      caused real API errors during past setups — set it deliberately, don't
      skip it.
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
Instagram do NOT. Meta delivers their `messages` webhooks for the **general
public** only when the app has **Advanced Access** on the messaging
permissions. With Standard Access (or in Development mode) webhooks fire
ONLY for users holding a role on the app — so "worked with my test account,
silent for real customers" is this gate, every time.

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
